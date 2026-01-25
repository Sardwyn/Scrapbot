// /var/www/scrapbot/src/lib/trustStore.js
//
// Trust + reputation store (global + per-channel), with TTL caching.
// Safe-by-default: if backing tables don't exist, returns neutral trust
// and disables DB writes (with a single warning log).
//
// Intended use:
//  - Read trust before enforcement decisions
//  - Record penalties after flood/swarm triggers
//  - Drive ban-on-sight flags via strong global signals
//
// IMPORTANT: This module does NOT execute moderation actions.
// It only reads/writes reputation state.

import { q } from "./db.js";

// -----------------------------
// Config
// -----------------------------

const DEFAULT_SCORE = 50; // neutral
const SCORE_MIN = 0;
const SCORE_MAX = 100;

const CACHE_TTL_MS = Number(process.env.SCRAPBOT_TRUST_CACHE_TTL_MS || 90_000);

// How many hot-signature swarm events before we flip ban-on-sight.
// You asked for "most serious offenders" = ban-on-sight.
// Default 2 is aggressive but not suicidal.
const HOT_SWARM_BAN_ON_SIGHT_THRESHOLD = Math.max(
  1,
  Number(process.env.SCRAPBOT_HOT_SWARM_BAN_THRESHOLD || 2)
);

// Optional: if you want any forced "override_ban" to instantly ban-on-sight,
// you can set this to 1. Default false (safer).
const OVERRIDE_BAN_IMMEDIATE_BOS =
  String(process.env.SCRAPBOT_OVERRIDE_BAN_IMMEDIATE_BOS || "false").toLowerCase() === "true";

// Simple tiers for UI/debugging (not for slow decision ladders).
const TIERS = [
  { name: "low", max: 25 },
  { name: "medium", max: 60 },
  { name: "high", max: 100 },
];

const TABLES = {
  global: "public.scrapbot_user_trust_global",
  channel: "public.scrapbot_user_trust_channel",
};

// -----------------------------
// Internal state
// -----------------------------

const cache = {
  global: new Map(),  // key: platform|userId -> { value, exp }
  channel: new Map(), // key: platform|channelSlug|userId -> { value, exp }
};

const dbSupport = {
  checked: false,
  ok: false,
  hasGlobal: false,
  hasChannel: false,
  warned: false,
};

// -----------------------------
// Helpers
// -----------------------------

function nowMs() {
  return Date.now();
}

function clampScore(n) {
  const x = Number.isFinite(n) ? n : DEFAULT_SCORE;
  return Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.round(x)));
}

function tierFor(score) {
  const s = clampScore(score);
  for (const t of TIERS) {
    if (s <= t.max) return t.name;
  }
  return "high";
}

function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (hit.exp <= nowMs()) {
    map.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(map, key, value) {
  map.set(key, { value, exp: nowMs() + CACHE_TTL_MS });
}

function cacheDelPrefix(map, prefix) {
  for (const k of map.keys()) {
    if (k.startsWith(prefix)) map.delete(k);
  }
}

async function ensureDbSupport() {
  if (dbSupport.checked) return dbSupport;

  dbSupport.checked = true;
  dbSupport.ok = false;
  dbSupport.hasGlobal = false;
  dbSupport.hasChannel = false;

  try {
    const { rows } = await q(
      `
      select table_schema, table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in ('scrapbot_user_trust_global','scrapbot_user_trust_channel')
      `
    );

    const names = new Set(rows.map((r) => String(r.table_name)));
    dbSupport.hasGlobal = names.has("scrapbot_user_trust_global");
    dbSupport.hasChannel = names.has("scrapbot_user_trust_channel");
    dbSupport.ok = dbSupport.hasGlobal && dbSupport.hasChannel;

    if (!dbSupport.ok && !dbSupport.warned) {
      dbSupport.warned = true;
      console.warn(
        "[trustStore] Trust tables not present yet; returning neutral trust and disabling DB writes until migrated.",
        {
          hasGlobal: dbSupport.hasGlobal,
          hasChannel: dbSupport.hasChannel,
          expectedTables: TABLES,
        }
      );
    }
  } catch (err) {
    if (!dbSupport.warned) {
      dbSupport.warned = true;
      console.warn("[trustStore] DB support check failed; running in neutral mode.", {
        error: String(err?.message || err),
      });
    }
  }

  return dbSupport;
}

function normalizePlatform(platform) {
  return String(platform || "kick").toLowerCase().trim();
}

function normalizeChannelSlug(channelSlug) {
  return String(channelSlug || "").toLowerCase().trim();
}

function normalizeUserId(userId) {
  if (userId == null) return null;
  const s = String(userId).trim();
  return s.length ? s : null;
}

function neutralTrust({ platform, channelSlug, userId } = {}) {
  const score = DEFAULT_SCORE;
  return {
    platform: normalizePlatform(platform),
    channelSlug: normalizeChannelSlug(channelSlug),
    userId: normalizeUserId(userId),
    global: {
      score,
      tier: tierFor(score),
      ban_on_sight: false,
      reasons: ["neutral_default"],
      counts: { flood: 0, swarm: 0, hot_signature_swarm: 0 },
    },
    channel: {
      score,
      tier: tierFor(score),
      reasons: ["neutral_default"],
      counts: { flood: 0, swarm: 0 },
    },
    effective: {
      score,
      tier: tierFor(score),
      reasons: ["neutral_default"],
    },
  };
}

// -----------------------------
// Reads
// -----------------------------

async function readGlobalTrust({ platform, userId }) {
  const p = normalizePlatform(platform);
  const uid = normalizeUserId(userId);
  if (!uid) return { score: DEFAULT_SCORE, ban_on_sight: false, reasons: ["missing_user_id"], counts: { flood: 0, swarm: 0, hot_signature_swarm: 0 } };

  const key = `${p}|${uid}`;
  const cached = cacheGet(cache.global, key);
  if (cached) return cached;

  const support = await ensureDbSupport();
  if (!support.hasGlobal) {
    const v = { score: DEFAULT_SCORE, ban_on_sight: false, reasons: ["no_global_table"], counts: { flood: 0, swarm: 0, hot_signature_swarm: 0 } };
    cacheSet(cache.global, key, v);
    return v;
  }

  try {
    const { rows } = await q(
      `
      select trust_score, ban_on_sight, flood_count, swarm_count, hot_signature_swarm_count
      from ${TABLES.global}
      where platform = $1 and user_id = $2
      limit 1
      `,
      [p, uid]
    );

    if (!rows?.length) {
      const v = { score: DEFAULT_SCORE, ban_on_sight: false, reasons: ["no_global_row"], counts: { flood: 0, swarm: 0, hot_signature_swarm: 0 } };
      cacheSet(cache.global, key, v);
      return v;
    }

    const r = rows[0];
    const v = {
      score: clampScore(r.trust_score),
      ban_on_sight: !!r.ban_on_sight,
      reasons: [],
      counts: {
        flood: Number(r.flood_count || 0),
        swarm: Number(r.swarm_count || 0),
        hot_signature_swarm: Number(r.hot_signature_swarm_count || 0),
      },
    };

    cacheSet(cache.global, key, v);
    return v;
  } catch {
    const v = { score: DEFAULT_SCORE, ban_on_sight: false, reasons: ["global_read_failed"], counts: { flood: 0, swarm: 0, hot_signature_swarm: 0 } };
    cacheSet(cache.global, key, v);
    return v;
  }
}

async function readChannelTrust({ platform, channelSlug, userId }) {
  const p = normalizePlatform(platform);
  const chan = normalizeChannelSlug(channelSlug);
  const uid = normalizeUserId(userId);
  if (!chan || !uid) return { score: DEFAULT_SCORE, reasons: ["missing_channel_or_user"], counts: { flood: 0, swarm: 0 } };

  const key = `${p}|${chan}|${uid}`;
  const cached = cacheGet(cache.channel, key);
  if (cached) return cached;

  const support = await ensureDbSupport();
  if (!support.hasChannel) {
    const v = { score: DEFAULT_SCORE, reasons: ["no_channel_table"], counts: { flood: 0, swarm: 0 } };
    cacheSet(cache.channel, key, v);
    return v;
  }

  try {
    const { rows } = await q(
      `
      select trust_score, flood_count, swarm_count
      from ${TABLES.channel}
      where platform = $1 and channel_id = $2 and user_id = $3
      limit 1
      `,
      [p, chan, uid]
    );

    if (!rows?.length) {
      const v = { score: DEFAULT_SCORE, reasons: ["no_channel_row"], counts: { flood: 0, swarm: 0 } };
      cacheSet(cache.channel, key, v);
      return v;
    }

    const r = rows[0];
    const v = {
      score: clampScore(r.trust_score),
      reasons: [],
      counts: {
        flood: Number(r.flood_count || 0),
        swarm: Number(r.swarm_count || 0),
      },
    };

    cacheSet(cache.channel, key, v);
    return v;
  } catch {
    const v = { score: DEFAULT_SCORE, reasons: ["channel_read_failed"], counts: { flood: 0, swarm: 0 } };
    cacheSet(cache.channel, key, v);
    return v;
  }
}

/**
 * Public: get trust snapshot (global + channel + effective).
 * Effective score is pessimistic (min(global, channel)).
 */
export async function getUserTrust({ platform = "kick", channelSlug, userId } = {}) {
  const p = normalizePlatform(platform);
  const chan = normalizeChannelSlug(channelSlug);
  const uid = normalizeUserId(userId);

  if (!uid) return neutralTrust({ platform: p, channelSlug: chan, userId: uid });

  const [g, c] = await Promise.all([
    readGlobalTrust({ platform: p, userId: uid }),
    readChannelTrust({ platform: p, channelSlug: chan, userId: uid }),
  ]);

  const globalScore = clampScore(g.score);
  const channelScore = clampScore(c.score);
  const effectiveScore = Math.min(globalScore, channelScore);

  const globalTier = tierFor(globalScore);
  const channelTier = tierFor(channelScore);
  const effectiveTier = tierFor(effectiveScore);

  const reasons = []
    .concat(g.reasons || [])
    .concat(c.reasons || [])
    .filter(Boolean);

  return {
    platform: p,
    channelSlug: chan,
    userId: uid,
    global: {
      score: globalScore,
      tier: globalTier,
      ban_on_sight: !!g.ban_on_sight,
      reasons: (g.reasons || []).length ? g.reasons : ["ok"],
      counts: g.counts || { flood: 0, swarm: 0, hot_signature_swarm: 0 },
    },
    channel: {
      score: channelScore,
      tier: channelTier,
      reasons: (c.reasons || []).length ? c.reasons : ["ok"],
      counts: c.counts || { flood: 0, swarm: 0 },
    },
    effective: {
      score: effectiveScore,
      tier: effectiveTier,
      reasons: reasons.length ? reasons : ["ok"],
    },
  };
}

/**
 * Public: quick check
 */
export async function isBanOnSight({ platform = "kick", userId } = {}) {
  const g = await readGlobalTrust({ platform, userId });
  return !!g?.ban_on_sight;
}

/**
 * Public: check if user SHOULD be ban-on-sight based on counts (even if flag not set yet)
 * Useful for transitional deployments.
 */
export async function shouldBanOnSightNow({ platform = "kick", userId } = {}) {
  const g = await readGlobalTrust({ platform, userId });
  const hot = Number(g?.counts?.hot_signature_swarm || 0);
  if (OVERRIDE_BAN_IMMEDIATE_BOS && hot >= 1) return true;
  return hot >= HOT_SWARM_BAN_ON_SIGHT_THRESHOLD || !!g?.ban_on_sight;
}

// -----------------------------
// Writes
// -----------------------------

async function writeGlobalDelta({
  platform,
  userId,
  deltaScore = 0,
  reason = "unspecified",
  banOnSight = null,
  inc = {},
}) {
  const p = normalizePlatform(platform);
  const uid = normalizeUserId(userId);
  if (!uid) return { ok: false, error: "missing_user_id" };

  const support = await ensureDbSupport();
  if (!support.hasGlobal) return { ok: false, disabled: true, reason: "no_global_table" };

  const floodInc = Number(inc.flood || 0);
  const swarmInc = Number(inc.swarm || 0);
  const hotSwarmInc = Number(inc.hot_signature_swarm || 0);

  try {
    await q(
      `
      insert into ${TABLES.global} (
        platform, user_id, trust_score,
        flood_count, swarm_count, hot_signature_swarm_count,
        ban_on_sight, last_reason, first_seen_at, last_seen_at, updated_at
      ) values (
        $1, $2, $3,
        $4, $5, $6,
        $7, $8, now(), now(), now()
      )
      on conflict (platform, user_id)
      do update set
        trust_score = greatest(${SCORE_MIN}, least(${SCORE_MAX}, ${TABLES.global}.trust_score + excluded.trust_score - ${DEFAULT_SCORE})),
        flood_count = ${TABLES.global}.flood_count + excluded.flood_count,
        swarm_count = ${TABLES.global}.swarm_count + excluded.swarm_count,
        hot_signature_swarm_count = ${TABLES.global}.hot_signature_swarm_count + excluded.hot_signature_swarm_count,
        ban_on_sight = case
          when ${TABLES.global}.ban_on_sight = true then true
          when excluded.ban_on_sight is null then ${TABLES.global}.ban_on_sight
          else excluded.ban_on_sight
        end,
        last_reason = excluded.last_reason,
        last_seen_at = now(),
        updated_at = now()
      `,
      [
        p,
        uid,
        clampScore(DEFAULT_SCORE + Number(deltaScore || 0)),
        floodInc,
        swarmInc,
        hotSwarmInc,
        banOnSight === null ? null : !!banOnSight,
        String(reason || "").slice(0, 240),
      ]
    );

    cache.global.delete(`${p}|${uid}`);
    cacheDelPrefix(cache.channel, `${p}|`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

async function writeChannelDelta({
  platform,
  channelSlug,
  userId,
  deltaScore = 0,
  reason = "unspecified",
  inc = {},
}) {
  const p = normalizePlatform(platform);
  const chan = normalizeChannelSlug(channelSlug);
  const uid = normalizeUserId(userId);
  if (!chan || !uid) return { ok: false, error: "missing_channel_or_user" };

  const support = await ensureDbSupport();
  if (!support.hasChannel) return { ok: false, disabled: true, reason: "no_channel_table" };

  const floodInc = Number(inc.flood || 0);
  const swarmInc = Number(inc.swarm || 0);

  try {
    await q(
      `
      insert into ${TABLES.channel} (
        platform, channel_id, user_id, trust_score,
        flood_count, swarm_count,
        last_reason, first_seen_at, last_seen_at, updated_at
      ) values (
        $1, $2, $3, $4,
        $5, $6,
        $7, now(), now(), now()
      )
      on conflict (platform, channel_id, user_id)
      do update set
        trust_score = greatest(${SCORE_MIN}, least(${SCORE_MAX}, ${TABLES.channel}.trust_score + excluded.trust_score - ${DEFAULT_SCORE})),
        flood_count = ${TABLES.channel}.flood_count + excluded.flood_count,
        swarm_count = ${TABLES.channel}.swarm_count + excluded.swarm_count,
        last_reason = excluded.last_reason,
        last_seen_at = now(),
        updated_at = now()
      `,
      [
        p,
        chan,
        uid,
        clampScore(DEFAULT_SCORE + Number(deltaScore || 0)),
        floodInc,
        swarmInc,
        String(reason || "").slice(0, 240),
      ]
    );

    cache.channel.delete(`${p}|${chan}|${uid}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

// -----------------------------
// Public write APIs
// -----------------------------

/**
 * Record a flood trigger (penalize local + global)
 * Flood is common; do not nuke the user globally on one event.
 */
export async function recordFloodTrigger({
  platform = "kick",
  channelSlug,
  userId,
  severity = "normal",
  reason = "flood_trigger",
  meta = null,
} = {}) {
  const sev = String(severity || "normal").toLowerCase();

  let channelDelta = -10;
  let globalDelta = -2;

  if (sev === "high") {
    channelDelta = -20;
    globalDelta = -5;
  }

  // Hard signals
  if (meta?.discordTriggered) globalDelta -= 20;
  if (meta?.urlTriggered) globalDelta -= 10;
  if (meta?.obfuscatedLinkTriggered) globalDelta -= 15;

  const [a, b] = await Promise.all([
    writeChannelDelta({
      platform,
      channelSlug,
      userId,
      deltaScore: channelDelta,
      reason,
      inc: { flood: 1 },
    }),
    writeGlobalDelta({
      platform,
      userId,
      deltaScore: globalDelta,
      reason,
      inc: { flood: 1 },
    }),
  ]);

  return { ok: true, channel: a, global: b };
}

/**
 * Record swarm participation (penalize global + optionally local)
 * Swarm is a stronger signal than flood. Act aggressively.
 */
export async function recordSwarmParticipation({
  platform = "kick",
  channelSlug,
  userId,
  severity = "normal",
  reason = "swarm_participation",
  meta = null,
} = {}) {
  const sev = String(severity || "normal").toLowerCase();

  let globalDelta = -25;
  let channelDelta = -5;

  if (sev === "high") {
    globalDelta = -40;
    channelDelta = -10;
  }

  // If the caller says this is hot-signature-backed, make it heavier,
  // but DO NOT flip ban-on-sight here. That's handled by recordHotSignatureSwarm().
  if (meta?.hotSignature) globalDelta -= 15;

  const [a, b] = await Promise.all([
    writeChannelDelta({
      platform,
      channelSlug,
      userId,
      deltaScore: channelDelta,
      reason,
      inc: { swarm: 1 },
    }),
    writeGlobalDelta({
      platform,
      userId,
      deltaScore: globalDelta,
      reason,
      inc: { swarm: 1 },
    }),
  ]);

  return { ok: true, channel: a, global: b };
}

/**
 * Record swarm + hot-signature.
 * This is the ONLY path that can promote a user toward ban-on-sight.
 *
 * Behavior:
 *  - increments hot_signature_swarm_count
 *  - heavy global penalty
 *  - sets ban_on_sight = true only once count crosses HOT_SWARM_BAN_ON_SIGHT_THRESHOLD
 */
export async function recordHotSignatureSwarm({
  platform = "kick",
  channelSlug,
  userId,
  reason = "swarm_hot_signature",
  meta = null,
} = {}) {
  const p = normalizePlatform(platform);
  const uid = normalizeUserId(userId);
  const chan = normalizeChannelSlug(channelSlug);

  if (!uid) return { ok: false, error: "missing_user_id" };

  // Read current global counts so we can flip BOS at a deliberate threshold.
  const gBefore = await readGlobalTrust({ platform: p, userId: uid });
  const beforeHot = Number(gBefore?.counts?.hot_signature_swarm || 0);
  const afterHot = beforeHot + 1;

  const shouldFlipBOS =
    (OVERRIDE_BAN_IMMEDIATE_BOS && meta?.forcedBan === true) ||
    afterHot >= HOT_SWARM_BAN_ON_SIGHT_THRESHOLD;

  const globalDelta = -60;
  const channelDelta = -15;

  const [a, b] = await Promise.all([
    writeChannelDelta({
      platform: p,
      channelSlug: chan,
      userId: uid,
      deltaScore: channelDelta,
      reason,
      inc: { swarm: 1 },
    }),
    writeGlobalDelta({
      platform: p,
      userId: uid,
      deltaScore: globalDelta,
      reason,
      banOnSight: shouldFlipBOS ? true : null,
      inc: { swarm: 1, hot_signature_swarm: 1 },
    }),
  ]);

  return {
    ok: true,
    channel: a,
    global: b,
    policy: {
      beforeHot,
      afterHot,
      ban_on_sight_threshold: HOT_SWARM_BAN_ON_SIGHT_THRESHOLD,
      flipped_ban_on_sight: !!shouldFlipBOS,
    },
  };
}

/**
 * Manual override: set ban-on-sight (no auto-clear)
 */
export async function setBanOnSight({
  platform = "kick",
  userId,
  value = true,
  reason = "manual_ban_on_sight",
} = {}) {
  const r = await writeGlobalDelta({
    platform,
    userId,
    deltaScore: 0,
    reason,
    banOnSight: !!value,
    inc: {},
  });
  return { ok: true, result: r };
}

/**
 * Clear caches (testing)
 */
export function trustStoreClearCache() {
  cache.global.clear();
  cache.channel.clear();
}
