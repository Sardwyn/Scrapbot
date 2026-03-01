import { getModerationRulesFor } from './moderationStore.js';
import { stripEmoji, isEmojiOnly } from './lib/textSig.js';

/**
 * Evaluate a chat message against moderation rules.
 * Returns a decision object (rule + action) or null.
 *
 * IMPORTANT BEHAVIOR CHANGE:
 * - Emoji-only / emoji-heavy messages are evaluated against a "no-emoji" view of the text,
 *   so phrase/regex rules won't accidentally time people out for hype.
 * - If the message is emoji-only, we do NOT apply text rules at all.
 */
export async function evaluateModeration({
  platform,
  scraplet_user_id,
  channelSlug,
  text,
  senderUsername,
  userRole,
  meta = {},
}) {
  try {
    // Basic guards
    if (!platform) return null;
    if (!scraplet_user_id) return null;
    if (typeof text !== 'string' || !text.trim()) return null;

    const role = (userRole || 'everyone').toLowerCase();

    // Safety: never moderate broadcaster by default
    if (role === 'broadcaster') return null;

    // Mods: allow moderation evaluation by default now.
    if (role === 'mod' && meta.ignoreMods === true) return null;

    // Some systems treat usernames starting with '@' as system mentions — ignore.
    if (typeof senderUsername === 'string' && senderUsername.startsWith('@')) {
      return null;
    }

    const rules = getModerationRulesFor(scraplet_user_id, platform);
    if (!Array.isArray(rules) || rules.length === 0) return null;

    const msgRaw = text.trim();

    // ✅ If emoji-only, do not run the text rule engine at all.
    if (isEmojiOnly(msgRaw)) return null;

    // ✅ Use an emoji-stripped view for matching.
    const msg = stripEmoji(msgRaw);
    if (!msg) return null;

    const lower = msg.toLowerCase();

    // Evaluate in order (first match wins)
    for (const rule of rules) {
      if (!rule || rule.enabled === false) continue;

      const ruleType = String(rule.rule_type || '').toLowerCase().trim();
      const ruleValue = String(rule.rule_value || '').trim();
      if (!ruleType || !ruleValue) continue;

      // Also strip emojis from the rule itself, so emoji rules won't match anything.
      const ruleValueStripped = stripEmoji(ruleValue);
      if (!ruleValueStripped) continue;

      const valueLower = ruleValueStripped.toLowerCase();

      let matched = false;
      let match_reason = '';

      // ----------------------------
      // Matchers
      // ----------------------------
      if (ruleType === 'contains') {
        matched = lower.includes(valueLower);
        if (matched) match_reason = `Message contains "${ruleValueStripped}"`;
      } else if (ruleType === 'equals') {
        matched = lower === valueLower;
        if (matched) match_reason = `Message exactly equals "${ruleValueStripped}"`;
      } else if (ruleType === 'blacklist_word') {
        // word-ish match (simple boundaries)
        const escaped = valueLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu');

        matched = re.test(msg);
        if (matched) match_reason = `Message contains blacklisted word "${ruleValueStripped}"`;
      } else if (ruleType === 'regex') {
        try {
          // Regex kept as-is, but applied to emoji-stripped msg.
          const re = new RegExp(ruleValue, 'i');
          matched = re.test(msg);
          if (matched) match_reason = `Message matched regex /${ruleValue}/i`;
        } catch {
          matched = false;
        }
      } else if (ruleType === 'caps_ratio') {
        // rule_value is a threshold like "0.8"
        const threshold = Number(ruleValueStripped);
        if (Number.isFinite(threshold) && msg.length >= 6) {
          const letters = msg.replace(/[^a-zA-Z]/g, '');
          if (letters.length >= 6) {
            const upper = (letters.match(/[A-Z]/g) || []).length;
            const ratio = upper / letters.length;
            matched = ratio >= threshold;
            if (matched) match_reason = `Caps ratio ${ratio.toFixed(2)} ≥ ${threshold}`;
          }
        }
      } else if (ruleType === 'link_posting') {
        // any obvious URL (emoji stripped already)
        matched = /(https?:\/\/|www\.)\S+/i.test(msg);

        if (matched) match_reason = 'Message contains a link';
      }

      if (!matched) continue;

      // Normalize action + duration so bans never carry a meaningless timeout
      const action = String(rule.action || 'none').toLowerCase();
      let duration_seconds = Number(rule.duration_seconds || 0) || 0;

      if (action === 'ban' || action === 'none') {
        duration_seconds = 0;
      } else if (action === 'timeout') {
        // If someone created a timeout rule with no duration, keep it sane.
        if (!Number.isFinite(duration_seconds) || duration_seconds <= 0) duration_seconds = 30;
      }

      return {
        matched: true,
        platform,
        scraplet_user_id,
        channelSlug: channelSlug || null,
        senderUsername: senderUsername || 'unknown',
        userRole: role,
        action,
        duration_seconds,
        rule: {
          id: rule.id,
          rule_type: rule.rule_type,
          rule_value: rule.rule_value,
        },
        explain: {
          match_reason,
          normalized_action: action,
          normalized_duration_seconds: duration_seconds,
          notes: action === 'ban' ? ['ban implies duration_seconds=0'] : [],
        },
      };
    }

    return null;
  } catch (err) {
    console.error('[moderationRuntime] evaluateModeration error', err);
    return null;
  }
}
