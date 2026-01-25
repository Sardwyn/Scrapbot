// src/moderationActions.js
// Execute moderation actions on Kick.
//
// Supports:
// - delete message (Kick Public API DELETE /chat/:message_id)
// - timeout / ban (Kick Public API POST /moderation/bans)
// - fallback to chat commands if user_id is missing

import { sendKickChatMessage } from './lib/kickChatSend.js';
import { kickBanOrTimeout, kickDeleteChatMessage } from './lib/kickModeration.js';

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

function secondsToMinutesCeil(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  return Math.max(1, Math.ceil(s / 60));
}

function isLiveEnabled() {
  // Safety latch: default is OFF.
  // Set SCRAPBOT_LIVE_MODERATION=1 to enable actually banning/timeouting/deleting.
  const v = String(process.env.SCRAPBOT_LIVE_MODERATION || '').toLowerCase().trim();
  return v === '1' || v === 'true' || v === 'yes';
}

function normalizeAction(action) {
  const a = String(action || '').toLowerCase();
  if (a === 'timeout' || a === 'ban' || a === 'delete') return a;
  if (a === 'none' || a === 'warn' || a === '') return 'none';
  return 'none';
}

function summarizeDecision(decision) {
  if (!decision) return 'none';
  const a = normalizeAction(decision.action);
  if (a === 'timeout') return `timeout ${Number(decision.duration_seconds || 0)}s`;
  if (a === 'ban') return 'ban';
  if (a === 'delete') return 'delete';
  return 'none';
}

/**
 * Attempt to delete the triggering message (if we have a message_id).
 * Requires the bot token to have moderation:chat_message:manage scope.
 */
export async function maybeDeleteMessage({ message_id }) {
  const mid = String(message_id || '').trim();
  if (!mid) return { ok: false, skipped: true, reason: 'no_message_id' };
  if (!isLiveEnabled()) return { ok: true, skipped: true, reason: 'live_disabled' };

  try {
    const resp = await kickDeleteChatMessage({ message_id: mid });
    return { ok: resp.ok, status: resp.status, data: resp.data || null };
  } catch (err) {
    return { ok: false, status: 0, error: err?.message || String(err) };
  }
}

/**
 * Execute a moderation action. Returns a structured result for logging.
 */
export async function executeModerationAction({
  platform = 'kick',
  broadcasterUserId,
  channelSlug,
  targetUserId,
  targetUsername,
  action,
  duration_seconds,
  reason,
  message_id,
  delete_message = true,
}) {
  const act = normalizeAction(action);

  const result = {
    ok: true,
    skipped: false,
    platform,
    channelSlug: channelSlug || null,
    action: act,
    duration_seconds: Number(duration_seconds || 0) || 0,
    targetUserId: targetUserId ? String(targetUserId) : null,
    targetUsername: targetUsername || null,
    reason: reason || null,
    liveEnabled: isLiveEnabled(),
    steps: [],
  };

  if (platform !== 'kick') {
    result.ok = false;
    result.error = 'executeModerationAction only supports kick right now';
    return result;
  }

  if (act === 'none') {
    result.skipped = true;
    return result;
  }

  // Optional delete step (best effort)
  if (delete_message && message_id) {
    const del = await maybeDeleteMessage({ message_id });
    result.steps.push({ step: 'delete_message', ...del });
  }

  // Safety latch
  if (!isLiveEnabled()) {
    result.skipped = true;
    result.reason = 'SCRAPBOT_LIVE_MODERATION is disabled';
    return result;
  }

  // Prefer API moderation when we have numeric user ids.
  const bId = toInt(broadcasterUserId);
  const uId = toInt(targetUserId);

  // Fallback path: use chat commands when user_id is missing.
  // Kick supports /timeout and /ban commands for moderators.
  if (!bId || !uId) {
    const uname = String(targetUsername || '').trim();
    if (!uname) {
      result.ok = false;
      result.error = 'missing target user_id and targetUsername';
      return result;
    }

    let cmd = '';
    if (act === 'timeout') {
      const mins = secondsToMinutesCeil(duration_seconds || 60);
      cmd = `/timeout ${uname} ${mins} ${String(reason || 'timeout').slice(0, 80)}`;
    } else if (act === 'ban') {
      cmd = `/ban ${uname} ${String(reason || 'ban').slice(0, 80)}`;
    } else {
      result.ok = false;
      result.error = `unsupported action fallback: ${act}`;
      return result;
    }

    try {
      await sendKickChatMessage({
        broadcasterUserId: broadcasterUserId,
        messageText: cmd,
        type: 'bot',
      });
      result.steps.push({ step: 'chat_command', ok: true, cmd });
      return result;
    } catch (err) {
      result.ok = false;
      result.steps.push({ step: 'chat_command', ok: false, cmd, error: err?.message || String(err) });
      return result;
    }
  }

  // API moderation path
  try {
    if (act === 'timeout') {
      const mins = secondsToMinutesCeil(duration_seconds || 60);
      const resp = await kickBanOrTimeout({
        broadcaster_user_id: bId,
        user_id: uId,
        duration_minutes: mins,
        reason: reason || 'timeout',
      });
      result.steps.push({ step: 'kick_api_timeout', ok: resp.ok, status: resp.status, data: resp.data || null, duration_minutes: mins });
      result.ok = !!resp.ok;
      return result;
    }

    if (act === 'ban') {
      const resp = await kickBanOrTimeout({
        broadcaster_user_id: bId,
        user_id: uId,
        duration_minutes: null,
        reason: reason || 'ban',
      });
      result.steps.push({ step: 'kick_api_ban', ok: resp.ok, status: resp.status, data: resp.data || null });
      result.ok = !!resp.ok;
      return result;
    }

    result.ok = false;
    result.error = `unsupported action: ${act}`;
    return result;
  } catch (err) {
    result.ok = false;
    result.error = err?.message || String(err);
    return result;
  }
}

/**
 * Execute a list of swarm actions (already pre-decided by swarmGuard).
 */
export async function executeSwarmActions({
  platform = 'kick',
  broadcasterUserId,
  channelSlug,
  message_id,
  actions = [],
}) {
  const out = [];
  for (const a of actions) {
    out.push(
      await executeModerationAction({
        platform,
        broadcasterUserId,
        channelSlug,
        message_id,
        action: a.action,
        duration_seconds: a.duration_seconds,
        reason: a.reason || a.signature_hash || 'swarm',
        targetUserId: a.target_user_id,
        targetUsername: a.target_username,
        delete_message: true,
      })
    );
  }
  return out;
}

export function decisionToActionPayload({ decision, event }) {
  if (!decision || !decision.action) return null;
  const act = normalizeAction(decision.action);
  if (act === 'none') return null;
  return {
    platform: event.platform || 'kick',
    broadcasterUserId: event?.meta?.broadcaster_user_id || event.broadcaster_user_id,
    channelSlug: event.channelSlug,
    message_id: event?.meta?.message_id || event.messageId || null,
    action: act,
    duration_seconds: decision.duration_seconds || 0,
    reason: decision.reason || decision?.explain?.match_reason || decision?.explain?.notes?.[0] || 'rule',
    targetUserId: event?.meta?.sender_user_id || event.senderUserId,
    targetUsername: event.senderUsername,
    delete_message: true,
  };
}

export function formatActionLog({ label, decision, result }) {
  return {
    label,
    decision: decision ? { ...decision, summary: summarizeDecision(decision) } : null,
    result: result || null,
  };
}
