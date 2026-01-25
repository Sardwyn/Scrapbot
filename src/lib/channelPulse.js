// src/lib/channelPulse.js
// Lightweight channel-level message-rate monitor (in-memory).
//
// IMPORTANT:
// The "pulse" signal is intentionally conservative. Organic hype should not
// toggle the system into a punitive mode. Defaults below are RAID-ONLY.
// Tightening behaviour is controlled elsewhere via SCRAPBOT_USE_PULSE_TRIPWIRE.
//
// ENV knobs (optional):
// - SCRAPBOT_PULSE_WINDOW_MS        (default 12000)  rolling window for user+msg counts
// - SCRAPBOT_PULSE_SHORT_MS         (default 4000)   short window for msg/sec
// - SCRAPBOT_PULSE_RATE_PER_SEC     (default 15)     msg/sec threshold (raid-only default)
// - SCRAPBOT_PULSE_UNIQUE_USERS     (default 12)     unique-user threshold (raid-only default)
// - SCRAPBOT_PULSE_HOLD_MS          (default 12000)  how long to keep spike active (short!)

const state = {
  channels: new Map(),
};

function nowMs() {
  return Date.now();
}

function keyOf({ platform, channelSlug, scraplet_user_id }) {
  return `${String(platform || 'kick').toLowerCase()}|${String(channelSlug || '').toLowerCase()}|${Number(scraplet_user_id || 0)}`;
}

function getChannel(key) {
  let st = state.channels.get(key);
  if (!st) {
    st = {
      events: [], // {ts, userKey}
      activeUntil: 0,
      lastPruneMs: 0,
    };
    state.channels.set(key, st);
  }
  return st;
}

function pruneEvents(st, cutoffMs) {
  if (!st.events.length) return;
  let i = 0;
  while (i < st.events.length && st.events[i].ts < cutoffMs) i++;
  if (i > 0) st.events.splice(0, i);
}

export function channelPulseTrack({ platform = 'kick', scraplet_user_id, channelSlug, senderUserId, senderUsername, meta = {} }) {
  // Guard: emoji-only hype should NOT contribute to channel pressure / tripwire.
  if (meta && meta.emoji_only === true) {
    return {
      active: false,
      short_rate_per_sec: 0,
      unique_users_short: 0,
      short_window_ms: Number(process.env.SCRAPBOT_PULSE_SHORT_MS || 4000),
      hold_ms: Number(process.env.SCRAPBOT_PULSE_HOLD_MS || 12000),
      tripwire: { floodTighten: false, swarmTighten: false },
    };
  }

  const t = nowMs();
  const key = keyOf({ platform, scraplet_user_id, channelSlug });
  const st = getChannel(key);

  const windowMs = Number(process.env.SCRAPBOT_PULSE_WINDOW_MS || 12000) || 12000;
  const shortMs  = Number(process.env.SCRAPBOT_PULSE_SHORT_MS || 4000) || 4000;

  const ratePerSec = Number(process.env.SCRAPBOT_PULSE_RATE_PER_SEC || 15) || 15;
  const minUnique  = Number(process.env.SCRAPBOT_PULSE_UNIQUE_USERS || 12) || 12;
  const holdMs     = Number(process.env.SCRAPBOT_PULSE_HOLD_MS || 12000) || 12000;

  const userKey = (senderUserId != null && String(senderUserId).trim() !== '')
    ? `id:${String(senderUserId)}`
    : `u:${String(senderUsername || 'unknown').toLowerCase()}`;

  st.events.push({ ts: t, userKey });

  const cutoff = t - windowMs;
  if (t - st.lastPruneMs > 250) {
    pruneEvents(st, cutoff);
    st.lastPruneMs = t;
  }

  const shortCutoff = t - shortMs;
  let shortCount = 0;
  const unique = new Set();
  for (let i = st.events.length - 1; i >= 0; i--) {
    const e = st.events[i];
    if (e.ts < shortCutoff) break;
    shortCount++;
    unique.add(e.userKey);
  }

  const shortRate = shortCount / Math.max(1, (shortMs / 1000));
  const uniqueUsers = unique.size;

  const shouldActivate = (shortRate >= ratePerSec) && (uniqueUsers >= minUnique);
  if (shouldActivate) {
    st.activeUntil = Math.max(st.activeUntil, t + holdMs);
  }

  const active = st.activeUntil > t;
  const tripwire = active ? { kind: 'pulse', floodTighten: true, swarmShield: true } : null;

  return {
    active,
    short_rate_per_sec: Number(shortRate.toFixed(2)),
    unique_users_short: uniqueUsers,
    short_window_ms: shortMs,
    hold_ms: holdMs,
    tripwire,
  };
}

export function prunePulseState(maxChannels = 5000) {
  if (state.channels.size <= maxChannels) return;
  state.channels.clear();
}