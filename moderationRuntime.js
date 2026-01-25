// moderationRuntime.js
import { getModerationRulesFor } from './moderationStore.js';

/**
 * Evaluate a chat message against moderation rules.
 * Returns a decision object (rule + action) or null.
 *
 * Notes:
 * - We still ignore broadcasters by default (safety).
 * - We DO allow mods to be evaluated (so you can test rules / or moderate mods if you want).
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
    // If you ever want to restore the old behavior without code changes,
    // you can pass meta.ignoreMods=true from inbound pipeline.
    if (role === 'mod' && meta.ignoreMods === true) return null;

    // Some systems treat usernames starting with '@' as system mentions — ignore.
    // (Keep this if you still want it; remove if it blocks real usernames.)
    if (typeof senderUsername === 'string' && senderUsername.startsWith('@')) {
      return null;
    }

    const rules = getModerationRulesFor(scraplet_user_id, platform);
    if (!Array.isArray(rules) || rules.length === 0) return null;

    const msg = text.trim();
    const lower = msg.toLowerCase();

    // Evaluate in order (first match wins)
    for (const rule of rules) {
      if (!rule || rule.enabled === false) continue;

      const ruleType = String(rule.rule_type || '').toLowerCase().trim();
      const ruleValue = String(rule.rule_value || '').trim();
      if (!ruleType || !ruleValue) continue;

      const valueLower = ruleValue.toLowerCase();

      let matched = false;
      let match_reason = '';

      // ----------------------------
      // Matchers
      // ----------------------------
      if (ruleType === 'contains') {
        matched = lower.includes(valueLower);
        if (matched) match_reason = `Message contains "${ruleValue}"`;
      } else if (ruleType === 'equals') {
        matched = lower === valueLower;
        if (matched) match_reason = `Message exactly equals "${ruleValue}"`;
      } else if (ruleType === 'blacklist_word') {
        // word-ish match (simple boundaries)
        const escaped = valueLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(^|\\W)${escaped}(\\W|$)`, 'i');
        matched = re.test(msg);
        if (matched) match_reason = `Message contains blacklisted word "${ruleValue}"`;
      } else if (ruleType === 'regex') {
        try {
          const re = new RegExp(ruleValue, 'i');
          matched = re.test(msg);
          if (matched) match_reason = `Message matched regex /${ruleValue}/i`;
        } catch {
          matched = false;
        }
      } else if (ruleType === 'caps_ratio') {
        // rule_value is a threshold like "0.8"
        const threshold = Number(ruleValue);
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
        // any obvious URL
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
