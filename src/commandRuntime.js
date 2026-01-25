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
 * Supports either plain string payload or { text: "..." } object.
 */
function renderTextTemplate(payload, { userName, channelSlug }) {
  if (!payload) return null;

  const raw =
    typeof payload === 'string'
      ? payload
      : typeof payload.text === 'string'
      ? payload.text
      : null;

  if (!raw) return null;

  return raw
    .replace(/\{user\}/g, userName || '')
    .replace(/\{channel\}/g, channelSlug || '');
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
        continue; // still cooling down
      }
    }

    const responseType = (cmd.response_type || 'text').toLowerCase();

    if (responseType === 'text') {
      const textOut = renderTextTemplate(cmd.response_payload, {
        userName,
        channelSlug,
      });

      if (!textOut) {
        console.log('[commands] matched command but empty payload', {
          id: cmd.id,
          name: cmd.name,
          payload: cmd.response_payload,
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
      });

      return {
        type: 'text',
        text: textOut,
      };
    }

    // Future: other response types (events, overlays, etc.)
  }

  console.log('[commands] no matching command for', text);
  return null;
}
