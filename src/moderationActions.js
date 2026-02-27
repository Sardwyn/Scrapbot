// src/moderationActions.js
// Execute moderation actions on Kick.
//
// Supports:
// - delete message (Kick Public API DELETE /chat/:message_id)
// - timeout / ban (Kick Public API POST /moderation/bans)
// - fallback to chat commands if user_id is missing
//
// IMPORTANT:
// - This file now logs executed/attempted actions into public.scrapbot_moderation_events
//   so DB becomes an audit ledger for “what we did”, not just “why we decided”.

import { sendKickChatMessage } from './sendChat.js';
import { q } from './lib/db.js';
import fetch from 'node-fetch';

import { kickBanOrTimeout, kickDeleteChatMessage } from './lib/kickModeration.js';
import { recordIncident } from './stores/intelStore.js';

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

function getEnforcementMode() {
  // Allowed: "off", "timeout_only", "full"
  // Runtime override (admin): globalThis.__scrapbot_enforcement
  const ov = String(globalThis.__scrapbot_enforcement || "").toLowerCase().trim();
  if (ov === "off" || ov === "timeout_only" || ov === "full") return ov;

  // Back-compat: SCRAPBOT_LIVE_MODERATION=1 => full (unless explicitly overridden).
  const m = String(process.env.SCRAPBOT_ENFORCEMENT || '').toLowerCase().trim();
  if (m === 'off' || m === 'timeout_only' || m === 'full') return m;

  return isLiveEnabled() ? 'full' : 'off';
}

function normalizeAction(action) {
  const a = String(action || '').toLowerCase();
  if (a === 'timeout' || a === 'ban' || a === 'delete') return a;
  if (a === 'none' || a === 'warn' || a === '' || a === 'ignore') return 'none';
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
 * Optional DB latch: respect moderation_settings.dry_run.
 * Disabled by default because your current enforcement is env-driven.
 * Enable by setting SCRAPBOT_RESPECT_DB_DRY_RUN=1.
 */
const _dryRunCache = new Map(); // key: tenant|platform -> { dry_run, expiresAt }
async function isDbDryRun({ scraplet_user_id, platform }) {
  const enabled = String(process.env.SCRAPBOT_RESPECT_DB_DRY_RUN || '').trim() === '1';
  if (!enabled) return false;

  const tenant = Number(scraplet_user_id || 0) || 0;
  const plat = String(platform || 'kick').toLowerCase();
  if (!tenant) return false;

  const key = `${tenant}|${plat}`;
  const now = Date.now();
  const cached = _dryRunCache.get(key);
  if (cached && cached.expiresAt > now) return !!cached.dry_run;

  try {
    const { rows } = await q(
      `
      SELECT dry_run
      FROM public.scrapbot_moderation_settings
      WHERE scraplet_user_id = $1 AND platform = $2
      LIMIT 1
      `,
      [tenant, plat]
    );
    const dry = rows?.[0]?.dry_run === true;
    _dryRunCache.set(key, { dry_run: dry, expiresAt: now + 15000 });
    return dry;
  } catch {
    // If DB check fails, do not block moderation.
    return false;
  }
}

const _sessionCache = new Map();

async function getSessionForModeration(platform, channelSlug) {
  if (!platform || !channelSlug) return null;
  const key = `${platform}:${channelSlug}`;
  const now = Date.now();
  const cached = _sessionCache.get(key);
  if (cached && cached.expires > now) {
    return cached.sessionId;
  }

  try {
    const internalKey = String(process.env.SCRAPLET_INTERNAL_KEY || "");
    const url = `http://127.0.0.1:3030/api/internal/session/current?platform=${encodeURIComponent(platform)}&channel=${encodeURIComponent(channelSlug)}`;

    const resp = await fetch(url, {
      headers: { 'x-scraplet-internal-key': internalKey }
    });
    if (!resp.ok) {
      _sessionCache.set(key, { sessionId: null, expires: now + 30000 });
      return null;
    }
    const data = await resp.json();
    const sessionId = data.session_id || null;
    _sessionCache.set(key, { sessionId, expires: now + 30000 });
    return sessionId;
  } catch (err) {
    _sessionCache.set(key, { sessionId: null, expires: now + 30000 });
    return null;
  }
}

async function logModerationEvent({
  scraplet_user_id,
  platform,
  channel_slug,
  sender_username,
  sender_user_id,
  user_role,
  message_id,
  message_text,
  matched,
  rule_id,
  rule_type,
  rule_value,
  action,
  duration_seconds,
}) {
  const sessionId = await getSessionForModeration(platform, channel_slug);

  try {
    await q(
      `
      INSERT INTO public.scrapbot_moderation_events (
        scraplet_user_id, platform, channel_slug, session_id,
        sender_username, sender_user_id, user_role,
        message_id, message_text,
        matched, rule_id, rule_type, rule_value,
        action, duration_seconds
      )
      VALUES (
        $1,$2,$3,$15,
        $4,$5,$6,
        $7,$8,
        $9,$10,$11,$12,
        $13,$14
      )
      `,
      [
        Number(scraplet_user_id || 0) || 0,
        String(platform || 'kick').toLowerCase(),
        channel_slug ? String(channel_slug).toLowerCase() : null,

        sender_username ? String(sender_username) : null,
        sender_user_id ? String(sender_user_id) : null,
        user_role ? String(user_role) : null,

        message_id ? String(message_id) : null,
        message_text ? String(message_text) : null,

        !!matched,
        rule_id != null ? Number(rule_id) : null,
        rule_type ? String(rule_type) : null,
        rule_value ? String(rule_value) : null,

        action ? String(action) : null,
        duration_seconds != null ? Number(duration_seconds) : null,
        sessionId,
      ]
    );
  } catch (e) {
    // don't break moderation if logging fails
    console.error('[moderationActions] failed to log moderation_event', e?.message || e);
  }
}

/**
 * Execute a moderation action. Returns a structured result for logging.
 *
 * rule_type: which engine produced it (swarm|flood|trust|rules|manual)
 * rule_value: signature hash or rule match value
 */
export async function executeModerationAction({
  platform = 'kick',
  scraplet_user_id,
  signature_hash,
  rule_type = 'engine',
  rule_id = null,
  rule_value = null,

  broadcasterUserId,
  channelSlug,
  targetUserId,
  targetUsername,
  user_role = null,

  action,
  duration_seconds,
  reason,
  message_id,
  message_text = null,

  delete_message = true,
}) {
  const act = normalizeAction(action);
  let enforcement = getEnforcementMode();
  const t0 = Date.now();

  // ✅ DRY RUN ENFORCEMENT
  if (arguments[0]?.dryRun) enforcement = 'off';

  // Optional DB latch
  const dbDry = await isDbDryRun({ scraplet_user_id, platform });
  if (dbDry) enforcement = 'off';

  // Enforce operator mode.
  let effectiveAction = act;
  let effectiveDuration = toInt(duration_seconds) || 0;

  if (enforcement === 'off') {
    effectiveAction = 'none';
  } else if (enforcement === 'timeout_only') {
    if (effectiveAction === 'ban') {
      effectiveAction = 'timeout';
      effectiveDuration = Math.max(effectiveDuration || 0, 600); // downgrade bans to >=10 min
    }
  }

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
    enforcement,
    steps: [],
  };

  // Bookkeeping: action attempt (best-effort)
  try {
    await recordIncident({
      platform: String(platform || 'kick').toLowerCase(),
      scraplet_user_id: Number(scraplet_user_id || 0) || 0,
      channel_slug: String(channelSlug || '').toLowerCase(),
      incident_type: 'action_attempt',
      severity: effectiveAction === 'ban' ? 4 : (effectiveAction === 'timeout' ? 3 : 1),
      signature_hash: signature_hash || null,
      signature_text: null,
      sample_text: String(reason || '').slice(0, 280),
      window_seconds: null,
      unique_users: null,
      total_messages: null,
      flags: null,
      actions: { action: effectiveAction, duration_seconds: effectiveDuration || 0, delete_message: !!delete_message },
      meta: { message_id: message_id || null, enforcement, db_dry_run: dbDry, rule_type, rule_id, rule_value: rule_value || signature_hash || null },
    });
  } catch { }

  async function finalizeResult() {
    try {
      await recordIncident({
        platform: String(platform || 'kick').toLowerCase(),
        scraplet_user_id: Number(scraplet_user_id || 0) || 0,
        channel_slug: String(channelSlug || '').toLowerCase(),
        incident_type: 'action_result',
        severity: effectiveAction === 'ban' ? 4 : (effectiveAction === 'timeout' ? 3 : 1),
        signature_hash: signature_hash || null,
        signature_text: null,
        sample_text: String(result?.reason || reason || result?.error || '').slice(0, 280),
        window_seconds: null,
        unique_users: null,
        total_messages: null,
        flags: null,
        actions: { action: effectiveAction, duration_seconds: effectiveDuration || 0, delete_message: !!delete_message },
        meta: {
          ok: !!result?.ok,
          skipped: !!result?.skipped,
          latency_ms: Date.now() - t0,
          message_id: message_id || null,
          enforcement,
          db_dry_run: dbDry,
          status: result?.status || null,
          api: result?.api || null,
          rule_type,
          rule_id,
          rule_value: rule_value || signature_hash || null,
        },
      });
    } catch { }
  }

  if (platform !== 'kick') {
    result.ok = false;
    result.error = 'executeModerationAction only supports kick right now';
    await finalizeResult();
    await logModerationEvent({
      scraplet_user_id,
      platform,
      channel_slug: channelSlug,
      sender_username: targetUsername,
      sender_user_id: targetUserId,
      user_role,
      message_id,
      message_text,
      matched: false,
      rule_id,
      rule_type,
      rule_value: rule_value || signature_hash || null,
      action: 'error',
      duration_seconds: 0,
    });
    return result;
  }

  if (act === 'none') {
    result.skipped = true;
    await finalizeResult();
    await logModerationEvent({
      scraplet_user_id,
      platform,
      channel_slug: channelSlug,
      sender_username: targetUsername,
      sender_user_id: targetUserId,
      user_role,
      message_id,
      message_text,
      matched: false,
      rule_id,
      rule_type,
      rule_value: rule_value || signature_hash || null,
      action: 'none',
      duration_seconds: 0,
    });
    return result;
  }

  // Optional delete step (best effort)
  let del = null;
  if (delete_message && message_id) {
    del = await maybeDeleteMessage({ message_id });
    result.steps.push({ step: 'delete_message', ...del });
  }

  // ✅ NEW: delete is a terminal action (delete only, no timeout/ban)
  if (effectiveAction === 'delete') {
    // If we had no message_id, del will be null; treat as skipped/failed accordingly.
    result.ok = del ? !!del.ok : false;
    result.skipped = del ? !!del.skipped : true;
    result.api = 'kick_api_delete';
    result.status = del ? (del.status || null) : null;

    await finalizeResult();
    await logModerationEvent({
      scraplet_user_id,
      platform,
      channel_slug: channelSlug,
      sender_username: targetUsername,
      sender_user_id: targetUserId,
      user_role,
      message_id,
      message_text,
      matched: true,
      rule_id,
      rule_type,
      rule_value: rule_value || signature_hash || null,
      action: 'delete',
      duration_seconds: 0,
    });
    return result;
  }

  // Safety latch (enforcement off via env or DB dry-run)
  if (enforcement === 'off') {
    result.skipped = true;
    result.reason = dbDry ? 'db_dry_run=true' : 'SCRAPBOT_ENFORCEMENT=off';
    result.action = effectiveAction;
    result.duration_seconds = effectiveDuration;

    await finalizeResult();
    await logModerationEvent({
      scraplet_user_id,
      platform,
      channel_slug: channelSlug,
      sender_username: targetUsername,
      sender_user_id: targetUserId,
      user_role,
      message_id,
      message_text,
      matched: true,
      rule_id,
      rule_type,
      rule_value: rule_value || signature_hash || null,
      action: 'skipped',
      duration_seconds: 0,
    });
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
      await finalizeResult();
      await logModerationEvent({
        scraplet_user_id,
        platform,
        channel_slug: channelSlug,
        sender_username: targetUsername,
        sender_user_id: targetUserId,
        user_role,
        message_id,
        message_text,
        matched: true,
        rule_id,
        rule_type,
        rule_value: rule_value || signature_hash || null,
        action: 'error',
        duration_seconds: 0,
      });
      return result;
    }

    let cmd = '';
    if (effectiveAction === 'timeout') {
      const mins = secondsToMinutesCeil(effectiveDuration || 60);
      cmd = `/timeout ${uname} ${mins} ${String(reason || 'timeout').slice(0, 80)}`;
    } else if (effectiveAction === 'ban') {
      cmd = `/ban ${uname} ${String(reason || 'ban').slice(0, 80)}`;
    } else {
      result.ok = false;
      result.error = `unsupported action fallback: ${act}`;
      await finalizeResult();
      await logModerationEvent({
        scraplet_user_id,
        platform,
        channel_slug: channelSlug,
        sender_username: targetUsername,
        sender_user_id: targetUserId,
        user_role,
        message_id,
        message_text,
        matched: true,
        rule_id,
        rule_type,
        rule_value: rule_value || signature_hash || null,
        action: 'error',
        duration_seconds: 0,
      });
      return result;
    }

    if (!broadcasterUserId) {
      console.warn('[moderationActions] chat-command fallback skipped: missing broadcasterUserId', { channelSlug, cmd });
      result.steps.push({ step: 'chat_command', ok: false, cmd, error: 'missing_broadcaster_user_id' });
      result.ok = false;
      result.error = 'missing_broadcaster_user_id';
      await finalizeResult();
      return result;
    }

    try {
      await sendKickChatMessage({
        broadcasterUserId: broadcasterUserId,
        channelSlug: channelSlug || null,
        text: cmd,
        type: 'bot',
      });
      result.steps.push({ step: 'chat_command', ok: true, cmd });
      result.ok = true;

      await finalizeResult();
      await logModerationEvent({
        scraplet_user_id,
        platform,
        channel_slug: channelSlug,
        sender_username: targetUsername,
        sender_user_id: targetUserId,
        user_role,
        message_id,
        message_text,
        matched: true,
        rule_id,
        rule_type,
        rule_value: rule_value || signature_hash || null,
        action: effectiveAction,
        duration_seconds: effectiveDuration || 0,
      });
      return result;
    } catch (err) {
      result.ok = false;
      result.error = err?.message || String(err);
      result.steps.push({ step: 'chat_command', ok: false, cmd, error: result.error });

      await finalizeResult();
      await logModerationEvent({
        scraplet_user_id,
        platform,
        channel_slug: channelSlug,
        sender_username: targetUsername,
        sender_user_id: targetUserId,
        user_role,
        message_id,
        message_text,
        matched: true,
        rule_id,
        rule_type,
        rule_value: rule_value || signature_hash || null,
        action: 'error',
        duration_seconds: 0,
      });
      return result;
    }
  }

  // API moderation path
  try {
    if (effectiveAction === 'timeout') {
      const mins = secondsToMinutesCeil(effectiveDuration || 60);
      const resp = await kickBanOrTimeout({
        broadcaster_user_id: bId,
        user_id: uId,
        duration_minutes: mins,
        reason: reason || 'timeout',
      });
      result.steps.push({ step: 'kick_api_timeout', ok: resp.ok, status: resp.status, data: resp.data || null, duration_minutes: mins });
      result.ok = !!resp.ok;
      result.status = resp.status || null;
      result.api = 'kick_api_timeout';

      await finalizeResult();
      await logModerationEvent({
        scraplet_user_id,
        platform,
        channel_slug: channelSlug,
        sender_username: targetUsername,
        sender_user_id: targetUserId,
        user_role,
        message_id,
        message_text,
        matched: true,
        rule_id,
        rule_type,
        rule_value: rule_value || signature_hash || null,
        action: effectiveAction,
        duration_seconds: effectiveDuration || 0,
      });

      return result;
    }

    if (effectiveAction === 'ban') {
      const resp = await kickBanOrTimeout({
        broadcaster_user_id: bId,
        user_id: uId,
        duration_minutes: null,
        reason: reason || 'ban',
      });
      result.steps.push({ step: 'kick_api_ban', ok: resp.ok, status: resp.status, data: resp.data || null });
      result.ok = !!resp.ok;
      result.status = resp.status || null;
      result.api = 'kick_api_ban';

      await finalizeResult();
      await logModerationEvent({
        scraplet_user_id,
        platform,
        channel_slug: channelSlug,
        sender_username: targetUsername,
        sender_user_id: targetUserId,
        user_role,
        message_id,
        message_text,
        matched: true,
        rule_id,
        rule_type,
        rule_value: rule_value || signature_hash || null,
        action: effectiveAction,
        duration_seconds: effectiveDuration || 0,
      });

      return result;
    }

    result.ok = false;
    result.error = `unsupported action: ${act}`;
    await finalizeResult();
    await logModerationEvent({
      scraplet_user_id,
      platform,
      channel_slug: channelSlug,
      sender_username: targetUsername,
      sender_user_id: targetUserId,
      user_role,
      message_id,
      message_text,
      matched: true,
      rule_id,
      rule_type,
      rule_value: rule_value || signature_hash || null,
      action: 'error',
      duration_seconds: 0,
    });
    return result;
  } catch (err) {
    result.ok = false;
    result.error = err?.message || String(err);

    await finalizeResult();
    await logModerationEvent({
      scraplet_user_id,
      platform,
      channel_slug: channelSlug,
      sender_username: targetUsername,
      sender_user_id: targetUserId,
      user_role,
      message_id,
      message_text,
      matched: true,
      rule_id,
      rule_type,
      rule_value: rule_value || signature_hash || null,
      action: 'error',
      duration_seconds: 0,
    });
    return result;
  }
}

/**
 * Execute a list of swarm actions (already pre-decided by swarmGuard).
 * IMPORTANT: pass scraplet_user_id + signature_hash through so we can log them.
 */
export async function executeSwarmActions({
  platform = 'kick',
  scraplet_user_id,
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
        scraplet_user_id,
        signature_hash: a.signature_hash || a.signatureHash || a.signature || a.signature_hash_exact || null,
        rule_type: 'swarm',
        rule_value: a.signature_hash || null,
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

  // Try to tag the decision source cleanly.
  // If your runtime uses decision.source, keep it; otherwise fall back.
  const ruleType = String(decision?.source || decision?.engine || decision?.rule_type || 'rules').toLowerCase();

  return {
    platform: event.platform || 'kick',
    scraplet_user_id: event.scraplet_user_id || event?.meta?.scraplet_user_id || null,
    signature_hash: decision?.meta?.signature_hash || decision?.signature_hash || null,
    rule_type: ruleType,
    rule_id: decision?.rule_id || null,
    rule_value: decision?.match_value || decision?.meta?.match_value || null,

    broadcasterUserId: event?.meta?.broadcaster_user_id || event.broadcaster_user_id,
    channelSlug: event.channelSlug,
    message_id: event?.meta?.message_id || event.messageId || null,
    message_text: event.text || null,

    action: act,
    duration_seconds: decision.duration_seconds || 0,
    reason: decision.reason || decision?.explain?.match_reason || decision?.explain?.notes?.[0] || 'rule',

    targetUserId: event?.meta?.sender_user_id || event.senderUserId,
    targetUsername: event.senderUsername,
    user_role: event.userRole || null,

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
