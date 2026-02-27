// src/commandRuntime.js
import { getCommandsFor } from './commandStore.js';

// In-memory cooldown tracker: commandId -> lastUsedEpochMs
const lastUsed = new Map();

/**
 * Check if user is allowed to run this command based on role field in DB.
 * cmdRole: 'everyone' | 'mod' | 'broadcaster'
 * userRole: 'everyone' | 'mod' | 'broadcaster'
 */
function isRoleAllowed(cmdRole, userRole) {
  const cmd = (cmdRole || 'everyone').toLowerCase();
  const user = (userRole || 'everyone').toLowerCase();

  if (cmd === 'everyone') return true;
  if (cmd === 'mod') {
    return user === 'mod' || user === 'broadcaster';
  }
  if (cmd === 'broadcaster') {
    return user === 'broadcaster';
  }
  return false;
}

/**
 * Very small template expansion for {user} and {channel}
 * Also supports $1..$9, $args, and simple DSL functions.
 */
function renderTextTemplate(payload, { userName, channelSlug, args = [] }) {
  if (!payload) return null;

  let raw =
    typeof payload === 'string'
      ? payload
      : typeof payload.text === 'string'
        ? payload.text
        : null;

  if (!raw) return null;

  // 1. Static {user} / {channel}
  raw = raw
    .replace(/\{user\}/g, userName || '')
    .replace(/\{channel\}/g, channelSlug || '');

  // 2. Arguments $1..$9
  for (let i = 1; i <= 9; i++) {
    const re = new RegExp(`\\$${i}`, 'g');
    raw = raw.replace(re, args[i - 1] || '');
  }

  // 3. $args (all arguments joined)
  raw = raw.replace(/\$args/g, args.join(' '));

  // 4. DSL: $random(a,b,c)
  raw = raw.replace(/\$random\(([^)]+)\)/g, (match, choicesStr) => {
    const choices = choicesStr.split(',').map((s) => s.trim());
    if (!choices.length) return '';
    return choices[Math.floor(Math.random() * choices.length)];
  });

  // 5. DSL: Case manipulation
  raw = raw.replace(/\$tolower\(([^)]+)\)/g, (match, inner) => inner.toLowerCase());
  raw = raw.replace(/\$toupper\(([^)]+)\)/g, (match, inner) => inner.toUpperCase());

  return raw.trim();
}

/**
 * Convert a matched command match result into a set of actions (v2).
 */
function resultToActions(cmd, { userName, channelSlug, args = [] }) {
  const actions = [];
  const responseType = (cmd.response_type || 'text').toLowerCase();

  if (responseType === 'text') {
    const textOut = renderTextTemplate(cmd.response_payload, {
      userName,
      channelSlug,
      args,
    });

    if (textOut) {
      actions.push({
        type: 'chat',
        text: textOut,
      });
    }
  }

  // Future: dispatch other types (overlay, tts, etc.) from cmd.response_payload
  return actions;
}

/**
 * Decide whether a chat message should trigger a command.
 * Returns a response object like { type: 'text', text: '...' } or null.
 */
export async function evaluateChatCommand({
  platform,
  channelSlug,
  userName,
  userRole, // 'everyone' | 'mod' | 'broadcaster'
  messageText,
}) {
  const platformKey = platform || 'kick';
  const text = (messageText || '').trim();

  // MVP: only commands starting with "!"
  if (!text.startsWith('!')) return null;

  const commands = getCommandsFor(platformKey, channelSlug) || [];
  const now = Date.now();

  // Debug: what do we actually have for this channel?
  console.log('[commands] evaluateChatCommand', {
    platformKey,
    channelSlug,
    text,
    userRole,
    count: commands.length,
    triggers: commands.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.trigger_type,
      pattern: c.trigger_pattern,
      role: c.role,
      cooldown: c.cooldown_seconds,
    })),
  });

  if (!commands.length) return null;

  const textLower = text.toLowerCase();

  for (const cmd of commands) {
    const triggerType = (cmd.trigger_type || 'prefix').toLowerCase();
    const triggerRaw = cmd.trigger_pattern || '';
    const triggerLower = triggerRaw.toLowerCase();

    let matched = false;

    if (triggerType === 'prefix') {
      // Be tolerant:
      // - if trigger is stored as "!test", match "!test ..."
      // - if trigger is stored as "test", treat "!test" as the prefix
      if (triggerLower.startsWith('!')) {
        matched = textLower.startsWith(triggerLower);
      } else {
        const prefixed = '!' + triggerLower;
        matched =
          textLower === prefixed || textLower.startsWith(prefixed + ' ');
      }
    } else if (triggerType === 'exact') {
      matched = textLower === triggerLower;
    } else if (triggerType === 'regex') {
      try {
        const re = new RegExp(triggerRaw, 'i');
        matched = re.test(text);
      } catch {
        matched = false;
      }
    }

    if (!matched) continue;

    // Argument extraction (split rest of message)
    // For prefix matches, args are whatever follows the trigger
    let args = [];
    if (triggerType === 'prefix') {
      const triggerUsed = triggerLower.startsWith('!') ? triggerLower : '!' + triggerLower;
      const rest = text.slice(textLower.indexOf(triggerUsed) + triggerUsed.length).trim();
      if (rest) args = rest.split(/\s+/);
    } else if (triggerType === 'regex') {
      try {
        const re = new RegExp(triggerRaw, 'i');
        const matchResult = text.match(re);
        if (matchResult) {
          // regex groups are arguments
          args = matchResult.slice(1);
        }
      } catch { }
    }

    // Role gating
    if (!isRoleAllowed(cmd.role, userRole)) {
      continue;
    }

    // Cooldown gating
    const cooldownSeconds = Number(cmd.cooldown_seconds || 0);
    if (cooldownSeconds > 0) {
      const last = lastUsed.get(cmd.id) || 0;
      const elapsed = (now - last) / 1000;
      if (elapsed < cooldownSeconds) {
        // Return a denied result with cooldown info for tracing
        return {
          matched: true,
          denied: true,
          reason: 'cooldown',
          remaining_seconds: Math.ceil(cooldownSeconds - elapsed),
          command: { id: cmd.id, name: cmd.name },
          actions: [],
        };
      }
    }

    const actions = resultToActions(cmd, { userName, channelSlug, args });

    if (actions.length === 0) {
      console.log('[commands] matched command but produced no actions', {
        id: cmd.id,
        name: cmd.name,
      });
      continue;
    }

    if (cooldownSeconds > 0) {
      lastUsed.set(cmd.id, now);
    }

    console.log('[commands] matched command', {
      id: cmd.id,
      name: cmd.name,
      trigger_type: cmd.trigger_type,
      trigger_pattern: cmd.trigger_pattern,
      actions_count: actions.length,
    });

    return {
      matched: true,
      command_id: cmd.id,
      name: cmd.name,
      actions,
      args,
      // Back-compat: existing code expects .type and .text if it's a simple text reply
      type: actions[0].type === 'chat' ? 'text' : null,
      text: actions[0].type === 'chat' ? actions[0].text : null,
    };
  }

  console.log('[commands] no matching command for', text);
  return null;
}
