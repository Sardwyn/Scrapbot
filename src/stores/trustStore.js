// /var/www/scrapbot/src/stores/trustStore.js
//
// Trust system:
// - Global trust: public.scrapbot_user_trust_global  (platform, user_id)
// - Channel trust: public.scrapbot_user_trust_channel (platform, channel_id, user_id)
//
// Design goals:
// - Accept BOTH calling styles:
//    { channelSlug, userId }  OR  { channel_id, user_id }
// - Fast reads via in-memory cache (short TTL)
// - Writes invalidate cache keys
// - Legacy support is OFF by default (only enabled if TRUST_ENABLE_LEGACY=true)

import { q } from "../lib/db.js";

// -----------------------------
// Config
// -----------------------------

const DEFAULT_SCORE = 50;
const SCORE_MIN = 0;
const SCORE_MAX = 100;

// TTL cache for reads (ms)
const CACHE_TTL_MS = Number(process.env.TRUST_CACHE_TTL_MS || 15_000);

// Legacy behaviour: OFF by default
const ENABLE_LEGACY = String(process.env.TRUST_ENABLE_LEGACY || "").toLowerCase() === "true";

// If you ever reintroduce legacy sources, keep them behind ENABLE_LEGACY.
// For now, legacy is intentionally inert.
function legacyDisabledNote() {
  return ENABLE_LEGACY ? null : "legacy_disabled";
}

const TABLES = {
  global: "public.scrapbot_user_trust_global",
  channel: "public.scrapbot_user_trust_channel",
};

// -----------------------------
// Tiny cache
// -----------------------------

const cache = {
  global: new Map(), // key => { value, exp }
  channel: new Map(), // key => { value, exp }
  support: { value: null, exp: 0 },
};

function nowMs() {
  return Date.now();
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

export function trustStoreClearCache() {
  cache.global.clear();
  cache.channel.clear();
  cache.support = { value: null, exp: 0 };
}

// -----------------------------
// Normalizers + arg adapter
// -----------------------------

function normalizePlatform(platform) {
  const p = String(platform || "kick").toLowerCase().trim();
  return p || "kick";
}

function normalizeChannelSlug(channelSlug) {
  const s = String(channelSlug || "").toLowerCase().trim();
  return s || null;
}

function normalizeUserId(userId) {
  if (userId == null) return null;
  const s = String(userId).trim();
  return s ? s : null;
}

/**
 * Accept both:
 *   channelSlug / userId
 *   channel_id  / user_id
 */
function normalizeArgs(input = {}) {
  const platform = normalizePlatform(input.platform);

  const channelSlug = normalizeChannelSlug(
    input.channelSlug ?? input.channel_id ?? input.channel ?? input.channelId ?? null
  );

  const userId = normalizeUserId(
    input.userId ?? input.user_id ?? input.uid ?? input.user ?? null
  );

  return { platform, channelSlug, userId };
}

function clampScore(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return DEFAULT_SCORE;
  if (x < SCORE_MIN) return SCORE_MIN;
  if (x > SCORE_MAX) return SCORE_MAX;
  return Math.round(x);
}

function tierFor(score) {
  const s = clampScore(score);
  if (s >= 80) return "trusted";
  if (s >= 60) return "normal";
  if (s >= 40) return "watch";
  if (s >= 25) return "suspect";
  return "hostile";
}

function neutralTrust({ platform, channelSlug, userId }) {
  const note = legacyDisabledNote();
  return {
    platform,
    channelSlug,
    userId,
    global: {
      score: DEFAULT_SCORE,
      tier: tierFor(DEFAULT_SCORE),
      ban_on_sight: false,
      reasons: note ? [note] : ["ok"],
      counts: { flood: 0, swarm: 0, hot_signature_swarm: 0 },
    },
    channel: {
      score: DEFAULT_SCORE,
      tier: tierFor(DEFAULT_SCORE),
      reasons: note ? [note] : ["ok"],
      counts: { flood: 0, swarm: 0 },
    },
    effective: {
      score: DEFAULT_SCORE,
      tier: tierFor(DEFAULT_SCORE),
      reasons: note ? [note] : ["ok"],
    },
  };
}

// -----------------------------
// DB support probe (cached)
// -----------------------------

async function ensureDbSupport() {
  const hit = cacheGet(
    new Map([["support", cache.support]]), // shim to use same TTL logic
    "support"
  );

  // The shim above won't work because cacheGet expects map entries shaped like {value, exp}.
  // So do support cache manually:
  if (cache.support.value && cache.support.exp > nowMs()) return cache.support.value;

  const support = { hasGlobal: false, hasChannel: false };

  try {
    const { rows } = await q(
      `
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in ('scrapbot_user_trust_global', 'scrapbot_user_trust_channel')
      `
    );

    const names = new Set((rows || []).map((r) => String(r.table_name)));
    support.hasGlobal = names.has("scrapbot_user_trust_global");
    support.hasChannel = names.has("scrapbot_user_trust_channel");
  } catch {
    // if introspection fails, behave as if not supported (safe)
    support.hasGlobal = false;
    support.hasChannel = false;
  }

  cache.support = { value: support, exp: nowMs() + 60_000 };
  return support;
}

// -----------------------------
// Reads (cached)
// -----------------------------

async function readGlobalTrust({ platform, userId }) {
  const p = normalizePlatform(platform);
  const uid = normalizeUserId(userId);
  if (!uid) return { score: DEFAULT_SCORE, ban_on_sight: false, reasons: ["missing_user_id"] };

  const key = `${p}|${uid}`;
  const cached = cacheGet(cache.global, key);
  if (cached) return cached;

  const support = await ensureDbSupport();
  if (!support.hasGlobal) {
    const v = { score: DEFAULT_SCORE, ban_on_sight: false, reasons: ["no_global_table"] };
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
      const v = { score: DEFAULT_SCORE, ban_on_sight: false, reasons: ["no_global_row"] };
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
    const v = { score: DEFAULT_SCORE, ban_on_sight: false, reasons: ["global_read_failed"] };
    cacheSet(cache.global, key, v);
    return v;
  }
}

async function readChannelTrust({ platform, channelSlug, userId }) {
  const p = normalizePlatform(platform);
  const chan = normalizeChannelSlug(channelSlug);
  const uid = normalizeUserId(userId);
  if (!chan || !uid) return { score: DEFAULT_SCORE, reasons: ["missing_channel_or_user"] };

  const key = `${p}|${chan}|${uid}`;
  const cached = cacheGet(cache.channel, key);
  if (cached) return cached;

  const support = await ensureDbSupport();
  if (!support.hasChannel) {
    const v = { score: DEFAULT_SCORE, reasons: ["no_channel_table"] };
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
      const v = { score: DEFAULT_SCORE, reasons: ["no_channel_row"] };
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
    const v = { score: DEFAULT_SCORE, reasons: ["channel_read_failed"] };
    cacheSet(cache.channel, key, v);
    return v;
  }
}

// -----------------------------
// Public API
// -----------------------------

/**
 * Public: get trust snapshot (global + channel + effective)
 */
export async function getUserTrust(input = {}) {
  const { platform, channelSlug, userId } = normalizeArgs(input);
  if (!userId) return neutralTrust({ platform, channelSlug, userId });

  const [g, c] = await Promise.all([
    readGlobalTrust({ platform, userId }),
    readChannelTrust({ platform, channelSlug, userId }),
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
    platform,
    channelSlug,
    userId,
    global: {
      score: globalScore,
      tier: globalTier,
      ban_on_sight: !!g.ban_on_sight,
      reasons: (g.reasons || []).length ? g.reasons : ["ok"],
      counts: g.counts || null,
    },
    channel: {
      score: channelScore,
      tier: channelTier,
      reasons: (c.reasons || []).length ? c.reasons : ["ok"],
      counts: c.counts || null,
    },
    effective: {
      score: effectiveScore,
      tier: effectiveTier,
      reasons: reasons.length ? reasons : ["ok"],
    },
  };
}

/**
 * Public: keep last_seen warm (no score change)
 */
export async function recordSeen(input = {}) {
  const { platform, channelSlug, userId } = normalizeArgs(input);
  if (!userId) return { ok: false, error: "missing_user_id" };

  const support = await ensureDbSupport();
  if (!support.hasGlobal && !support.hasChannel) {
    return { ok: false, disabled: true, reason: "no_trust_tables" };
  }

  // Best-effort: touching rows without changing scores.
  // We implement as deltaScore=0 write paths, but avoid incrementing counters.
  const [a, b] = await Promise.allSettled([
    support.hasGlobal
      ? writeGlobalDelta({ platform, userId, deltaScore: 0, reason: "seen", banOnSight: null, inc: {} })
      : null,
    support.hasChannel && channelSlug
      ? writeChannelDelta({ platform, channelSlug, userId, deltaScore: 0, reason: "seen", inc: {} })
      : null,
  ]);

  // Don’t fail inbound if these fail
  const ok = (a.status !== "rejected") || (b.status !== "rejected");
  return { ok: !!ok };
}

/**
 * Public: ban-on-sight quick check
 */
export async function isBanOnSight(input = {}) {
  const { platform, userId } = normalizeArgs(input);
  if (!userId) return false;
  const g = await readGlobalTrust({ platform, userId });
  return !!g?.ban_on_sight;
}

/**
 * Public: decide if we should instantly act *before* running the heavier pipeline.
 *
 * Philosophy:
 * - If ban_on_sight => hostile ban
 * - Else if effective trust is very low => hostile timeout
 * - Keep it deterministic and cheap.
 */
export async function shouldAutoHostileAction(input = {}) {
  const { platform, channelSlug, userId } = normalizeArgs(input);
  const emoji_only = input && (input.emoji_only === true || input.emote_only === true);
  // Guard: emoji-only hype should never trigger hostile-floor actions.
  if (emoji_only) return { ok: true, hostile: false, reason: "emoji_only" };

  if (!userId) return { ok: false, hostile: false, reason: "missing_user_id" };

  const trust = await getUserTrust({ platform, channelSlug, userId });

  // 1) Ban-on-sight
  if (trust?.global?.ban_on_sight) {
    return {
      ok: true,
      hostile: true,
      action: "ban",
      duration_seconds: 0,
      reason: "ban_on_sight",
      trust,
    };
  }

  // 2) Hard low-trust floor (fast aggression path)
  // Tune these numbers later, but keep a crisp line.
  const eff = Number(trust?.effective?.score ?? DEFAULT_SCORE);

  if (eff <= 15) {
    return {
      ok: true,
      hostile: true,
      action: "timeout",
      duration_seconds: 3600, // 60m default “get out”
      reason: "trust_hostile_floor",
      trust,
    };
  }

  // If you later want “under attack => harsher”, pass tripwire in input and use it here.
  return { ok: true, hostile: false, trust };
}

// -----------------------------
// Writes (penalties / flags)
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
        clampScore(DEFAULT_SCORE + Number(deltaScore || 0)), // delta around default, see formula
        floodInc,
        swarmInc,
        hotSwarmInc,
        banOnSight === null ? null : !!banOnSight,
        String(reason || "").slice(0, 240),
      ]
    );

    cache.global.delete(`${p}|${uid}`);
    cacheDelPrefix(cache.channel, `${p}|`); // conservative invalidation
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

/**
 * Public: record a flood trigger (penalize local + global)
 */
export async function recordFloodTrigger(input = {}) {
  const { platform, channelSlug, userId } = normalizeArgs(input);
  const severity = String(input.severity || "normal").toLowerCase();
  const reason = String(input.reason || "flood_trigger");
  const meta = input.meta || null;

  if (!userId) return { ok: false, error: "missing_user_id" };

  let channelDelta = -10;
  let globalDelta = -2;

  if (severity === "high") {
    channelDelta = -20;
    globalDelta = -5;
  }

  if (meta?.discordTriggered) globalDelta -= 20;
  if (meta?.urlTriggered) globalDelta -= 10;
  if (meta?.obfuscatedLinkTriggered) globalDelta -= 15;

  const [a, b] = await Promise.all([
    channelSlug
      ? writeChannelDelta({ platform, channelSlug, userId, deltaScore: channelDelta, reason, inc: { flood: 1 } })
      : { ok: false, disabled: true, reason: "missing_channel" },
    writeGlobalDelta({ platform, userId, deltaScore: globalDelta, reason, inc: { flood: 1 } }),
  ]);

  return { ok: true, channel: a, global: b };
}

/**
 * Public: record swarm participation (penalize global + local)
 */
export async function recordSwarmParticipation(input = {}) {
  const { platform, channelSlug, userId } = normalizeArgs(input);
  const severity = String(input.severity || "normal").toLowerCase();
  const reason = String(input.reason || "swarm_participation");
  const meta = input.meta || null;

  if (!userId) return { ok: false, error: "missing_user_id" };

  let globalDelta = -25;
  let channelDelta = -5;

  if (severity === "high") {
    globalDelta = -40;
    channelDelta = -10;
  }

  if (meta?.hotSignature) globalDelta -= 15;

  const [a, b] = await Promise.all([
    channelSlug
      ? writeChannelDelta({ platform, channelSlug, userId, deltaScore: channelDelta, reason, inc: { swarm: 1 } })
      : { ok: false, disabled: true, reason: "missing_channel" },
    writeGlobalDelta({ platform, userId, deltaScore: globalDelta, reason, inc: { swarm: 1 } }),
  ]);

  return { ok: true, channel: a, global: b };
}

/**
 * Public: record swarm+hot-signature (eligible for ban-on-sight)
 * This is the explicit, deliberate path to set ban_on_sight = true.
 */
export async function recordHotSignatureSwarm(input = {}) {
  const { platform, channelSlug, userId } = normalizeArgs(input);
  const reason = String(input.reason || "swarm_hot_signature");
  const meta = input.meta || null;

  if (!userId) return { ok: false, error: "missing_user_id" };

  const globalDelta = -60;
  const channelDelta = -15;

  const [a, b] = await Promise.all([
    channelSlug
      ? writeChannelDelta({ platform, channelSlug, userId, deltaScore: channelDelta, reason, inc: { swarm: 1 } })
      : { ok: false, disabled: true, reason: "missing_channel" },
    writeGlobalDelta({
      platform,
      userId,
      deltaScore: globalDelta,
      reason,
      banOnSight: true,
      inc: { swarm: 1, hot_signature_swarm: 1 },
    }),
  ]);

  return { ok: true, channel: a, global: b, meta: meta || null };
}

/**
 * Public: manual override for ban-on-sight (rare)
 */
export async function setBanOnSight(input = {}) {
  const { platform, userId } = normalizeArgs(input);
  const value = input.value !== false;
  const reason = String(input.reason || "manual_ban_on_sight");
  if (!userId) return { ok: false, error: "missing_user_id" };

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
