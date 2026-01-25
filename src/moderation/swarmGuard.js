// /var/www/scrapbot/src/moderation/swarmGuard.js
import { capsRatio, hasUrl, normalizeExact, normalizeFuzzy, hashSig } from '../lib/textSig.js';
import { recordIncident, upsertGlobalSignatureIntel } from '../stores/intelStore.js';
import { q } from '../lib/db.js';

const state = {
  channels: new Map(), // key: platform|channelSlug|tenant -> channelState
};

// TTL caches to avoid DB hits on every message (big perf win)
const settingsCache = new Map();   // key -> { value, expiresAt }
const overridesCache = new Map();  // key -> { value, expiresAt }
const CACHE_TTL_MS = Math.max(1000, Number(process.env.SCRAPBOT_SWARM_CACHE_TTL_MS || 15000) || 15000);

function nowMs() { return Date.now(); }

function collapseEmojiRuns(s) {
  // Keep signatures stable and avoid hype emojis creating false collisions.
  // Example: "😂😂😂😂" -> "😂×4"
  const str = String(s || '');
  let out = '';
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    const isEmojiish = ch.charCodeAt(0) > 127 && !/\s/.test(ch);
    if (!isEmojiish) {
      out += ch;
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < str.length && str[j] === ch) j++;
    const run = j - i;
    if (run >= 3) out += `${ch}×${run}`;
    else out += str.slice(i, j);
    i = j;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function cacheKey(scraplet_user_id, platform) {
  return `${Number(scraplet_user_id || 0)}:${String(platform || 'kick').toLowerCase()}`;
}

function getChannelKey(platform, channelSlug, scraplet_user_id) {
  return `${platform}|${channelSlug || ''}|${scraplet_user_id || 0}`;
}

function getChannelState(key) {
  let st = state.channels.get(key);
  if (!st) {
    st = {
      // EXACT signature is the enforcement key
      messagesByExact: new Map(),   // sigHashExact -> [{ts, userId, username, text, flags}]
      // FUZZY signature is analytics only (never used for enforcement)
      messagesByFuzzy: new Map(),   // sigHashFuzzy -> [{ts, userId, username, text, flags}]

      shield: null,                // { sigHashExact, untilMs, startedMs, reason, shield_kind }
      userStrike: new Map(),       // userId -> { lastExactSig, strikes, lastTs }
      lastCleanup: 0,
    };
    state.channels.set(key, st);
  }
  return st;
}

function cleanup(st, windowMs) {
  const t = nowMs();
  if (t - st.lastCleanup < 2000) return;
  st.lastCleanup = t;

  for (const [sig, arr] of st.messagesByExact.entries()) {
    const filtered = arr.filter(m => (t - m.ts) <= windowMs);
    if (filtered.length) st.messagesByExact.set(sig, filtered);
    else st.messagesByExact.delete(sig);
  }

  for (const [sig, arr] of st.messagesByFuzzy.entries()) {
    const filtered = arr.filter(m => (t - m.ts) <= windowMs);
    if (filtered.length) st.messagesByFuzzy.set(sig, filtered);
    else st.messagesByFuzzy.delete(sig);
  }

  if (st.shield && st.shield.untilMs <= t) st.shield = null;
}

async function loadSettingsFresh(scraplet_user_id, platform) {
  const { rows } = await q(
    `
    SELECT *
    FROM public.scrapbot_moderation_settings
    WHERE scraplet_user_id = $1 AND platform = $2
    LIMIT 1
    `,
    [scraplet_user_id, platform]
  );
  return rows[0] || null;
}

async function loadOverridesFresh(scraplet_user_id, platform) {
  const { rows } = await q(
    `
    SELECT signature_hash, mode, enabled
    FROM public.scrapbot_signature_overrides
    WHERE scraplet_user_id = $1 AND platform = $2 AND enabled = true
    `,
    [scraplet_user_id, platform]
  );
  const allow = new Set();
  const ban = new Set();
  for (const r of rows) {
    if (r.mode === 'allow') allow.add(r.signature_hash);
    if (r.mode === 'ban') ban.add(r.signature_hash);
  }
  return { allow, ban };
}

async function loadSettings(scraplet_user_id, platform) {
  const key = cacheKey(scraplet_user_id, platform);
  const t = nowMs();
  const cached = settingsCache.get(key);
  if (cached && cached.expiresAt > t) return cached.value;

  const value = await loadSettingsFresh(scraplet_user_id, platform);
  settingsCache.set(key, { value, expiresAt: t + CACHE_TTL_MS });
  return value;
}

async function loadOverrides(scraplet_user_id, platform) {
  const key = cacheKey(scraplet_user_id, platform);
  const t = nowMs();
  const cached = overridesCache.get(key);
  if (cached && cached.expiresAt > t) return cached.value;

  const value = await loadOverridesFresh(scraplet_user_id, platform);
  overridesCache.set(key, { value, expiresAt: t + CACHE_TTL_MS });
  return value;
}

/**
 * Swarm output contract:
 * {
 *   matched: boolean,
 *   tripped: boolean,                 // threshold reached on this message (shield started/refreshed)
 *   shield: { sigHashExact, untilMs, startedMs, reason, shield_kind } | null,
 *   signature_hash: string,           // EXACT hash (enforcement)
 *   signature_text: string,           // EXACT text (canonical)
 *   flags: { has_url, caps_ratio },
 *   actions: [ ... ]
 * }
 */
export async function evaluateSwarm(event) {
  const platform = String(event.platform || 'kick').toLowerCase();
  const channelSlug = String(event.channelSlug || '').toLowerCase();
  const tenant = Number(event.scraplet_user_id || 0) || 0;

  if (!tenant || !channelSlug) return { matched: false, actions: [] };

  const settings = await loadSettings(tenant, platform);
  if (!settings || !settings.swarm_enabled) return { matched: false, actions: [] };

  // ignore mods/broadcaster always
  const role = String(event.userRole || 'everyone');
  if (role === 'mod' || role === 'broadcaster') return { matched: false, actions: [] };

  const text = String(event.text || '');
  if (text.length < (settings.swarm_min_message_length || 8)) return { matched: false, actions: [] };

  // --- Canonical fingerprints ---
  // IMPORTANT: We enforce ONLY on exact canonical duplicates.
  const exactNormRaw = normalizeExact(text);
  const exactNorm = collapseEmojiRuns(exactNormRaw);
  const sigHashExact = hashSig(exactNorm);

  // Fuzzy can be kept for analytics/visibility only (never enforcement)
  const fuzzyNormRaw = normalizeFuzzy(text);
  const fuzzyNorm = collapseEmojiRuns(fuzzyNormRaw);
  const sigHashFuzzy = hashSig(fuzzyNorm);

  const key = getChannelKey(platform, channelSlug, tenant);
  const st = getChannelState(key);

  const windowSeconds = Number(settings.swarm_window_seconds || 10) || 10;
  const windowMs = windowSeconds * 1000;
  cleanup(st, windowMs);

  // IMPORTANT: inboundKick provides senderUserId at top-level.
  const kickUserId = event?.senderUserId != null
    ? String(event.senderUserId)
    : (event?.meta?.sender_user_id ? String(event.meta.sender_user_id) : null);

  const username = String(event.senderUsername || '');

  const flags = {
    has_url: hasUrl(text),
    caps_ratio: capsRatio(text),
  };

  // Track message under EXACT sig (enforcement scope)
  const arrExact = st.messagesByExact.get(sigHashExact) || [];
  arrExact.push({
    ts: nowMs(),
    userId: kickUserId || username || 'unknown',
    username,
    text,
    flags,
  });
  st.messagesByExact.set(sigHashExact, arrExact);

  // Track message under FUZZY sig (analytics only)
  const arrFuzzy = st.messagesByFuzzy.get(sigHashFuzzy) || [];
  arrFuzzy.push({
    ts: nowMs(),
    userId: kickUserId || username || 'unknown',
    username,
    text,
    flags,
  });
  st.messagesByFuzzy.set(sigHashFuzzy, arrFuzzy);

  const uniqueUsersExact = new Set(arrExact.map(m => m.userId)).size;
  const totalMessagesExact = arrExact.length;

  const overrides = await loadOverrides(tenant, platform);

  // IMPORTANT: overrides apply to the enforcement hash (EXACT)
  if (overrides.allow.has(sigHashExact)) return { matched: false, actions: [] };

  let threshold = Number(settings.swarm_unique_users_threshold || 6) || 6;

  // Tripwire escalation (channelPulse)
  // pulse-only “high energy” chat caused false positives; still opt-in.
  const usePulseTripwire = String(globalThis.__scrapbot_use_pulse_tripwire ?? process.env.SCRAPBOT_USE_PULSE_TRIPWIRE ?? '0') === '1';
  if (usePulseTripwire && event.__tripwire?.swarmShield === true) {
    threshold = Math.max(3, Math.floor(threshold * 0.8));
  }

  const forcedBan = overrides.ban.has(sigHashExact);

  // Require repetition, not just “N people said it once”.
  const minTotalMessages = Math.ceil(threshold * 1.5);

  // ✅ The enforcement condition is *EXACT duplicates across unique users*.
  const tripped = uniqueUsersExact >= threshold && totalMessagesExact >= minTotalMessages;

  // ---- Start/refresh shield on threshold hit (EXACT only)
  if (tripped) {
    const shieldSeconds = Number(settings.swarm_shield_seconds || 90) || 90;
    const untilMs = nowMs() + shieldSeconds * 1000;

    const wasShielding = !!st.shield;
    st.shield = {
      sigHashExact,
      untilMs,
      startedMs: wasShielding ? st.shield.startedMs : nowMs(),
      reason: event.__tripwire?.swarmShield ? 'pulse_tripwire' : 'swarm_threshold',
      shield_kind: 'swarm_threshold',
    };

    let scoreDelta = 10;
    if (flags.has_url) scoreDelta += 20;
    if (flags.caps_ratio >= 0.7) scoreDelta += 10;

    // Intel writes keyed by EXACT (because this is the only enforceable identity)
    await upsertGlobalSignatureIntel({
      platform,
      signature_hash: sigHashExact,
      signature_text: exactNorm,
      sample_text: text,
      tenant_id: tenant,
      channel_slug: channelSlug,
      shield_triggered: true,
      tags: { has_url: !!flags.has_url },
      score_delta: scoreDelta,
      hot_for_seconds: 2 * 60 * 60,
    });

    // Add a reason trace so you can debug “why did it trip?”
    await recordIncident({
      platform,
      scraplet_user_id: tenant,
      channel_slug: channelSlug,
      incident_type: 'swarm_start',
      severity: flags.has_url ? 'high' : 'warn',
      signature_hash: sigHashExact,
      signature_text: exactNorm,
      sample_text: text,
      window_seconds: windowSeconds,
      unique_users: uniqueUsersExact,
      total_messages: totalMessagesExact,
      flags,
      actions: [],
      meta: {
        threshold,
        minTotalMessages,
        // Debug: what we grouped by (exact vs fuzzy)
        exact: { sigHash: sigHashExact, sigText: exactNorm },
        fuzzy_analytics: { sigHash: sigHashFuzzy, sigText: fuzzyNorm },
        enforcement_mode: 'exact_only',
        pulse_tripwire: !!event.__tripwire?.swarmShield,
      },
    });
  }

  // ---- Enforce while shield is active for this EXACT sig
  const actions = [];
  if (st.shield && st.shield.sigHashExact === sigHashExact) {
    const userKey = kickUserId || username || 'unknown';
    const strike = st.userStrike.get(userKey) || { strikes: 0, lastExactSig: null, lastTs: 0 };

    const shieldMs = (Number(settings.swarm_shield_seconds || 90) || 90) * 1000;

    if (strike.lastExactSig === sigHashExact && (nowMs() - strike.lastTs) <= shieldMs) {
      strike.strikes += 1;
    } else {
      strike.strikes = 1;
    }
    strike.lastExactSig = sigHashExact;
    strike.lastTs = nowMs();
    st.userStrike.set(userKey, strike);

    const immediateBan = !!settings.swarm_immediate_ban_if_url && flags.has_url;
    const firstAction = settings.swarm_first_action || 'timeout';
    const repeatAction = settings.swarm_repeat_action || 'ban';

    const firstDuration = Number(settings.swarm_first_duration_seconds || 60) || 60;
    const repeatDuration = Number(settings.swarm_repeat_duration_seconds || 600) || 600;

    let chosen = null;
    let enforcement_source = null;

    if (forcedBan) {
      chosen = { action: 'ban', duration_seconds: 0, reason: 'override_ban' };
      enforcement_source = 'override_ban';
      st.shield.shield_kind = 'hot_signature';
    } else if (immediateBan) {
      chosen = { action: 'ban', duration_seconds: 0, reason: 'url_in_shield' };
      enforcement_source = 'url_in_shield';
      st.shield.shield_kind = 'hot_signature';
    } else if (strike.strikes === 1) {
      // ✅ First hit during an active shield: suppress the message (delete) but do NOT punish yet.
      // This avoids nuking legit copypasta/hype swarms while still keeping chat clean.
      chosen = { action: 'delete', duration_seconds: 0, reason: 'shield_first_delete' };
      enforcement_source = 'shield_first_delete';
    } else if (strike.strikes === 2) {
      // ✅ Second hit by the same user during the shield: apply the configured first action (usually timeout).
      chosen = { action: firstAction, duration_seconds: firstDuration, reason: 'shield_second_hit' };
      enforcement_source = 'shield_second_hit';
    } else {
      // ✅ Third+ hit by the same user during the shield: escalate (repeat action).
      chosen = { action: repeatAction, duration_seconds: repeatDuration, reason: 'shield_repeat_hit' };
      enforcement_source = 'shield_repeat_hit';
      if (String(repeatAction).toLowerCase() === 'ban') {
        st.shield.shield_kind = 'hot_signature';
      }
    }

    if (chosen && chosen.action !== 'none') {
      const actionLower = String(chosen.action || '').toLowerCase();
      const isBan = actionLower === 'ban';

      const hot_signature =
        forcedBan ||
        immediateBan ||
        (enforcement_source === 'shield_repeat_hit' && isBan);

      const ban_on_sight_candidate =
        forcedBan || immediateBan || isBan;

      actions.push({
        ...chosen,
        target_user_id: kickUserId,
        target_username: username,
        signature_hash: sigHashExact,
        hot_signature,
        enforcement_source,
        ban_on_sight_candidate,
      });

      await recordIncident({
        platform,
        scraplet_user_id: tenant,
        channel_slug: channelSlug,
        incident_type: 'swarm_enforcement',
        severity: chosen.action === 'ban' ? 'high' : (chosen.action === 'timeout' ? 'warn' : 'info'),
        signature_hash: sigHashExact,
        signature_text: exactNorm,
        sample_text: text,
        window_seconds: windowSeconds,
        unique_users: uniqueUsersExact,
        total_messages: totalMessagesExact,
        flags,
        actions: [chosen],
        meta: {
          strikes: strike.strikes,
          enforcement_source,
          hot_signature,
          ban_on_sight_candidate,
          forcedBan,
          immediateBan,
          enforcement_mode: 'exact_only',
        },
      });
    }
  }

  return {
    matched: !!st.shield && st.shield.sigHashExact === sigHashExact,
    tripped,
    shield: st.shield ? { ...st.shield } : null,
    signature_hash: sigHashExact,
    signature_text: exactNorm,
    flags,
    actions,
  };
}

export function swarmClearCaches() {
  settingsCache.clear();
  overridesCache.clear();
}
