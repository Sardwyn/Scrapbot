// src/lib/floodGuard.js
import db from "./db.js";

// Emoji-only messages should NOT contribute to flood detection.
// We keep this local (no new module) and fail open if Unicode property escapes are unavailable.
function isEmojiOnly(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (/[a-z0-9]/i.test(raw)) return false;
  try {
    const reEmoji = new RegExp('\\p{Extended_Pictographic}', 'gu');
    const rePunctSym = new RegExp('[\\s\\p{P}\\p{S}]', 'gu');
    const stripped = raw
      .replace(reEmoji, '')
      .replace(/[\\uFE0F\\u200D]/g, '')
      .replace(rePunctSym, '');
    return stripped.length === 0;
  } catch {
    return !/[a-z0-9]/i.test(raw);
  }
}


// Cache settings to avoid DB hit per message (TTL-based)
const settingsCache = new Map(); // key -> { settings, expiresAt }
const SETTINGS_TTL_MS = 10_000;

// Track user message events + strikes
// key -> { events: Array<{t,cost,norm,flags}>, strikes:number, lastTripAt:number }
const userState = new Map();

function nowMs() {
  return Date.now();
}
function cacheKey(scraplet_user_id, platform) {
  return `${Number(scraplet_user_id)}:${String(platform || "kick").toLowerCase()}`;
}
function userKey({ scraplet_user_id, platform, channelSlug, senderUserId, senderUsername }) {
  const uid = senderUserId ? String(senderUserId) : `name:${String(senderUsername || "unknown").toLowerCase()}`;
  return `${cacheKey(scraplet_user_id, platform)}:${String(channelSlug || "").toLowerCase()}:${uid}`;
}

function coerceInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function coerceBool(v, fallback) {
  if (v === true || v === false) return v;
  if (typeof v === "string") {
    const s = v.toLowerCase().trim();
    if (["1", "true", "yes", "y"].includes(s)) return true;
    if (["0", "false", "no", "n"].includes(s)) return false;
  }
  return fallback;
}

export async function getModerationSettings(scraplet_user_id, platform = "kick") {
  const key = cacheKey(scraplet_user_id, platform);
  const cached = settingsCache.get(key);
  const t = nowMs();
  if (cached && cached.expiresAt > t) return cached.settings;

  const p = String(platform || "kick").toLowerCase();

  // Ensure row exists
  const { rows } = await db.query(
    `
    INSERT INTO public.scrapbot_moderation_settings
      (scraplet_user_id, platform)
    VALUES
      ($1, $2)
    ON CONFLICT (scraplet_user_id)
    DO UPDATE SET platform = EXCLUDED.platform
    RETURNING *
    `,
    [Number(scraplet_user_id), p]
  );

  const s = rows[0] || {};

  // Keep your existing knobs, but allow more realistic defaults:
  // - still "5 msgs / 10s" baseline, but detection now uses weighted scoring.
  const settings = {
    scraplet_user_id: Number(scraplet_user_id),
    platform: p,

    flood_enabled: coerceBool(s.flood_enabled, true),
    flood_window_seconds: coerceInt(s.flood_window_seconds, 10),
    flood_max_messages: coerceInt(s.flood_max_messages, 5), // we treat as a baseline score threshold
    flood_action: String(s.flood_action || "timeout"),
    flood_duration_seconds: coerceInt(s.flood_duration_seconds, 30),

    flood_escalate: coerceBool(s.flood_escalate, true),
    flood_escalate_multiplier: coerceInt(s.flood_escalate_multiplier, 2),
    flood_max_duration_seconds: coerceInt(s.flood_max_duration_seconds, 600),
    flood_cooldown_seconds: coerceInt(s.flood_cooldown_seconds, 120),

    // Swarm / Shield Guard
    swarm_enabled: coerceBool(s.swarm_enabled, true),
    swarm_window_seconds: coerceInt(s.swarm_window_seconds, 10),
    swarm_min_unique_users: coerceInt(s.swarm_min_unique_users, 6),
    swarm_min_repeats: coerceInt(s.swarm_min_repeats, 8),
    swarm_cooldown_seconds: coerceInt(s.swarm_cooldown_seconds, 120),
    swarm_action: String(s.swarm_action || "timeout").toLowerCase(),
    swarm_duration_seconds: coerceInt(s.swarm_duration_seconds, 30),
    swarm_promote_global: coerceBool(s.swarm_promote_global, true),
    swarm_promote_confidence: Number(s.swarm_promote_confidence) || 0.75,
    sig_lowercase: coerceBool(s.sig_lowercase, true),
    sig_strip_punct: coerceBool(s.sig_strip_punct, true),
    sig_collapse_ws: coerceBool(s.sig_collapse_ws, true),
    sig_strip_emojis: coerceBool(s.sig_strip_emojis, false),
    swarm_escalate: coerceBool(s.swarm_escalate, true),
    swarm_escalate_repeat_threshold: coerceInt(s.swarm_escalate_repeat_threshold, 2),
    swarm_escalate_action: String(s.swarm_escalate_action || "ban").toLowerCase(),
  };

  settingsCache.set(key, { settings, expiresAt: t + SETTINGS_TTL_MS });
  return settings;
}

export function clearSettingsCache(scraplet_user_id, platform = "kick") {
  settingsCache.delete(cacheKey(scraplet_user_id, platform));
}

// ------------------------------
// Content heuristics
// ------------------------------

function normalizeText(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .trim()
    // collapse whitespace
    .replace(/\s+/g, " ")
    // common obfuscation cleanup
    .replace(/\[dot\]|\(dot\)|\{dot\}/g, " dot ")
    .replace(/\[\.]|\(\.\)|\{\.\}/g, ".")
    .replace(/`/g, "")
    .trim();
  return s;
}

function capsRatio(text) {
  const s = String(text || '');
  let letters = 0;
  let caps = 0;
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    const isAZ = code >= 65 && code <= 90;
    const isaz = code >= 97 && code <= 122;
    if (isAZ || isaz) {
      letters += 1;
      if (isAZ) caps += 1;
    }
  }
  return letters ? (caps / letters) : 0;
}


function hasUrlLike(text) {
  // Plain URL patterns
  if (/(https?:\/\/|www\.)/i.test(text)) return true;

  // Domain-ish patterns: something.tld
  if (/\b[a-z0-9-]{2,}\.(com|net|org|gg|tv|io|co|app|ru|xyz|top|live|shop|store|info|me|uk|us)\b/i.test(text)) {
    return true;
  }

  // Obfuscations: "w w w", "dot", " d0t ", "c0m", "hxxp"
  if (/\bw\s*w\s*w\b/i.test(text)) return true;
  if (/\b(hxxp|hxxps)\b/i.test(text)) return true;
  if (/\b(d0t|do+t)\b/i.test(text)) return true;
  if (/\b(c0m|n3t|0rg)\b/i.test(text)) return true;

  return false;
}

function isDiscordInvite(text) {
  const t = text.toLowerCase();
  // Discord + common invite shapes
  return (
    t.includes("discord.gg") ||
    t.includes("discord.com/invite") ||
    /\bdiscord\s*gg\b/i.test(t) ||
    /\bdiscord\s*\.?\s*gg\b/i.test(t)
  );
}

function looksLikeEmojiOnly(text) {
  // Node supports Unicode property escapes in modern versions.
  // Emoji-only: allow whitespace + punctuation + pictographs, but no letters/numbers.
  const t = String(text || "").trim();
  if (!t) return false;

  // If it has letters/numbers, not emoji-only
  if (/[a-z0-9]/i.test(t)) return false;

  // Must contain at least one pictograph/emoji-ish char
  try {
    if (!/\p{Extended_Pictographic}/u.test(t)) return false;
  } catch {
    // Fallback if runtime doesn't support property escapes: treat short non-alnum as emoji-ish
    if (t.length < 1) return false;
  }

  return true;
}

function hasMixedTextAndEmoji(text) {
  const t = String(text || "").trim();
  if (!t) return false;

  const hasLetters = /[a-z]/i.test(t);
  let hasEmoji = false;
  try {
    hasEmoji = /\p{Extended_Pictographic}/u.test(t);
  } catch {
    hasEmoji = false;
  }
  return hasLetters && hasEmoji;
}

function scoreMessage(text) {
  const norm = normalizeText(text);
  const flags = {
    emojiOnly: looksLikeEmojiOnly(text),
    mixed: hasMixedTextAndEmoji(text),
    urlLike: hasUrlLike(norm),
    discord: isDiscordInvite(norm),
  };

  // Base costs (token bucket weights):
  // - emoji-only: extremely cheap (Kick already rate-limits; emojis shouldn't trip flood)
  // - mixed text+emoji: slightly below baseline (emojis shouldn't make text worse)
  // - normal text: baseline
  // - url-like: high
  // - discord: very high
  let cost = 1;
  if (flags.emojiOnly) cost = 0.05;
  else if (flags.mixed) cost = 0.75;
  else cost = 1;

  // Caps weighting: shouting should cost more than calm text.
  const caps = capsRatio(text);
  if (caps >= 0.9) cost *= 2.2;
  else if (caps >= 0.7) cost *= 1.6;
  else if (caps >= 0.5) cost *= 1.25;

  if (flags.urlLike) cost = Math.max(cost, 3);
  if (flags.discord) cost = Math.max(cost, 6);

  return { norm, flags, cost };
}

/**
 * Evaluate flood spam for a message.
 * Returns a "decision-like" object or null.
 */
export async function evaluateFloodGuard({
  platform,
  scraplet_user_id,
  channelSlug,
  senderUsername,
  senderUserId,
  userRole,
  text,
  __tripwire,
  meta = {},
}) {
  if (!scraplet_user_id) return null;
  // Guard: emoji-only hype should not be treated as flooding.
  if (meta && meta.emoji_only === true) return null;
  if (isEmojiOnly(text)) return null;

  if (!platform) return null;
  if (typeof text !== "string" || !text.trim()) return null;

  const role = String(userRole || "everyone").toLowerCase();
  if (role === "broadcaster") return null;
  // You already skip mods upstream sometimes, but keep it safe here too:
  if (role === "mod") return null;

  const settings = await getModerationSettings(scraplet_user_id, platform);
  if (!settings.flood_enabled) return null;

  // Window + baseline threshold (we treat flood_max_messages as “score budget”)
  let windowSec = Math.max(1, Number(settings.flood_window_seconds) || 10);

  // Baseline budget: if DB says “5 msgs”, we treat that as score budget ~5
  // (so 6 normal text messages in 10s trips, but ~14 emoji-only messages would trip)
  let scoreBudget = Math.max(1, Number(settings.flood_max_messages) || 5);

  // Tripwire tightening (channelPulse)
  const usePulseTripwire = String(globalThis.__scrapbot_use_pulse_tripwire ?? process.env.SCRAPBOT_USE_PULSE_TRIPWIRE ?? '0') === '1';
  if (usePulseTripwire && __tripwire?.floodTighten === true) {
    windowSec = Math.max(1, Math.floor(windowSec / 2));
    scoreBudget = Math.max(1, Math.floor(scoreBudget / 2));
  }

  const action = String(settings.flood_action || "timeout").toLowerCase();
  const baseDuration = Math.max(0, Number(settings.flood_duration_seconds) || 30);

  const { norm, flags, cost } = scoreMessage(text);

  const k = userKey({ scraplet_user_id, platform, channelSlug, senderUserId, senderUsername });
  const t = nowMs();

  let st = userState.get(k);
  if (!st) {
    st = { events: [], strikes: 0, lastTripAt: 0 };
    userState.set(k, st);
  }

  // Keep only events within window
  const cutoff = t - windowSec * 1000;
  st.events = st.events.filter((e) => e.t >= cutoff);

  st.events.push({ t, cost, norm, flags });

  // Duplicate spam detector:
  // If the same normalized message repeats a lot, treat as flood even if low “score”.
  // (This is the “10–20 accounts spam the same message 10 times” pattern — except per-user.
  // SwarmGuard catches cross-user; this catches single-user copy/paste too.)
  const DUP_THRESHOLD = flags.emojiOnly ? 999 : 4; // don’t punish emote spam for duplicates
  let dupCount = 0;
  for (const e of st.events) {
    if (e.norm === norm) dupCount += 1;
  }
  const dupTriggered = dupCount >= DUP_THRESHOLD;

  // Score-based flood trigger
  const totalScore = st.events.reduce((sum, e) => sum + (Number(e.cost) || 0), 0);
  const scoreTriggered = totalScore > scoreBudget;

  // Immediate-trigger content (these are almost always spam)
  // - Discord invites: trip fast even at low rate
  // - URL-like content: stricter than normal text
  const urlTriggered = flags.urlLike && st.events.filter((e) => e.flags.urlLike).length >= 2; // two linkish msgs in-window
  const discordTriggered = flags.discord && st.events.filter((e) => e.flags.discord).length >= 1; // one discord invite is enough

  if (!dupTriggered && !scoreTriggered && !urlTriggered && !discordTriggered) return null;

  // Escalation / cooldown logic (same as your v1 but reused)
  const cooldownSec = Math.max(0, Number(settings.flood_cooldown_seconds) || 120);
  const withinCooldown = st.lastTripAt && t - st.lastTripAt <= cooldownSec * 1000;

  if (settings.flood_escalate) {
    if (withinCooldown) st.strikes += 1;
    else st.strikes = 1;
  } else {
    st.strikes = 1;
  }
  st.lastTripAt = t;

  // Duration: escalate, but bump harder for links/discord
  let duration = baseDuration;
  if (settings.flood_escalate) {
    const mult = Math.max(1, Number(settings.flood_escalate_multiplier) || 2);
    const maxDur = Math.max(0, Number(settings.flood_max_duration_seconds) || 600);
    duration = Math.floor(baseDuration * Math.pow(mult, Math.max(0, st.strikes - 1)));
    if (maxDur > 0) duration = Math.min(duration, maxDur);
  }

  // Make link spam harsher than emoji spam
  if (discordTriggered) duration = Math.max(duration, 300); // 5 min
  else if (urlTriggered) duration = Math.max(duration, 120); // 2 min

  return {
    matched: true,
    source: "flood_guard",
    platform: String(platform).toLowerCase(),
    scraplet_user_id: Number(scraplet_user_id),
    channelSlug: channelSlug || null,
    senderUsername: senderUsername || "unknown",
    senderUserId: senderUserId ? String(senderUserId) : null,
    userRole: role,
    action, // upstream code can still map "ban"->"timeout" if you want
    duration_seconds: duration,
    rule: {
      id: null,
      rule_type: "flood_guard",
      rule_value: `budget=${scoreBudget} window=${windowSec}s`,
    },
    meta: {
      window_seconds: windowSec,
      score_budget: scoreBudget,
      total_score: Number(totalScore.toFixed(2)),
      strikes: st.strikes,
      count_in_window: st.events.length,
      triggers: {
        scoreTriggered,
        dupTriggered,
        urlTriggered,
        discordTriggered,
      },
      content: {
        cost,
        flags,
        norm,
        dupCount,
      },
    },
  };
}

/**
 * Simple memory cleanup so this doesn't grow forever.
 */
export function pruneFloodState(maxKeys = 50_000) {
  if (userState.size <= maxKeys) return;
  userState.clear();
}