// /var/www/scrapbot/src/lib/probeKickModerator.js
//
// Truthfully determine whether a token has moderation authority on Kick.
//
// Preferred probe (deterministic):
//   DELETE /public/v1/chat/:message_id using a fake-but-valid UUID.
//     404 = authorized (message doesn't exist, but authz passed)  ✅
//     204 = authorized (deleted; should not happen with fake UUID) ✅
//     401 = token missing/invalid                                 ❌
//     403 = not permitted                                          ❌
//
// Legacy probe (DISABLED by default):
//   POST /public/v1/moderation/bans (or equivalent via kickBanOrTimeout)
//   This is often indeterminate because 400/422 can be validation/business-rule noise.
//   Only enable if you *explicitly* opt in.
//
// Caching:
//   - Cache is in-memory per-process (PM2 fork). Fine for now.
//   - Cache key includes channel + "token fingerprint" (so a token change invalidates cache).
//   - Short TTLs to avoid stale UI but stop spamming the Kick API.

import { kickBanOrTimeout } from "./kickModeration.js";

// -----------------------------
// Config
// -----------------------------
const KICK_API_BASE = process.env.KICK_API_BASE || "https://api.kick.com/public/v1";
const NON_EXISTENT_MESSAGE_ID = "00000000-0000-4000-8000-000000000000";

// Network timeout for the probe request itself (ms)
const PROBE_TIMEOUT_MS = Number(process.env.KICK_PROBE_TIMEOUT_MS || 4000);

// Cache TTLs (ms)
const CACHE_TTL_OK_MS = Number(process.env.KICK_PROBE_CACHE_OK_MS || 60_000); // 60s
const CACHE_TTL_BAD_MS = Number(process.env.KICK_PROBE_CACHE_BAD_MS || 15_000); // 15s (failures/unreachable)
const CACHE_MAX_ENTRIES = Number(process.env.KICK_PROBE_CACHE_MAX || 1000);

// Legacy probe disabled by default.
const ALLOW_LEGACY_BY_DEFAULT =
  String(process.env.KICK_ALLOW_LEGACY_PROBE || "").trim() === "1";

// -----------------------------
// Tiny in-memory cache
// -----------------------------
/**
 * @type {Map<string, { value: any, expiresAt: number }>}
 */
const cache = new Map();

function nowMs() {
  return Date.now();
}

function pruneCacheIfNeeded() {
  // Remove expired first
  const t = nowMs();
  for (const [k, v] of cache.entries()) {
    if (!v || v.expiresAt <= t) cache.delete(k);
  }

  // If still too big, delete oldest-ish by insertion order (Map keeps order)
  while (cache.size > CACHE_MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (!firstKey) break;
    cache.delete(firstKey);
  }
}

function normalizeChannelId(channelSlug) {
  return String(channelSlug || "").toLowerCase().trim();
}

function tokenFingerprint(accessToken) {
  // We do NOT need cryptographic hashing; this is just a cache key salt.
  // Use a tiny fingerprint so the full token never ends up in memory keys/logs.
  const t = String(accessToken || "");
  if (!t) return "no-token";
  return `${t.slice(0, 8)}…${t.slice(-6)}:${t.length}`;
}

function cacheKey({ channelId, accessToken, allowLegacy }) {
  return `kick:${channelId}:tok=${tokenFingerprint(accessToken)}:legacy=${allowLegacy ? 1 : 0}`;
}

function getCached(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (e.expiresAt <= nowMs()) {
    cache.delete(key);
    return null;
  }
  return e;
}

function setCached(key, value, ttlMs) {
  cache.set(key, { value, expiresAt: nowMs() + Math.max(0, Number(ttlMs) || 0) });
  pruneCacheIfNeeded();
}

// -----------------------------
// Status mapping
// -----------------------------
function classifyChatDelete(status) {
  const s = Number(status || 0) || 0;

  // Authority proven
  if (s === 204) return { ok: true, mod_status: "ok", http_code: s, note: "deleted" };
  if (s === 404) return { ok: true, mod_status: "ok", http_code: s, note: "message_not_found_probe" };

  // Auth / permission
  if (s === 401) return { ok: false, mod_status: "unauthorized", http_code: s };
  if (s === 403) return { ok: false, mod_status: "forbidden", http_code: s };

  // Rate / server
  if (s === 429) return { ok: false, mod_status: "rate_limited", http_code: s };
  if (s >= 500) return { ok: false, mod_status: "error", http_code: s };

  // 400 here means malformed request / invalid UUID format (should not happen with our UUID)
  if (s === 400) return { ok: false, mod_status: "invalid", http_code: s, note: "bad_request_not_authority_signal" };

  if (s > 0) return { ok: false, mod_status: "error", http_code: s };
  return { ok: false, mod_status: "unknown", http_code: 0 };
}

function classifyBanEndpoint(status) {
  const s = Number(status || 0) || 0;

  if (s >= 200 && s < 300) return { ok: true, mod_status: "ok", http_code: s };

  if (s === 401) return { ok: false, mod_status: "unauthorized", http_code: s };
  if (s === 403) return { ok: false, mod_status: "forbidden", http_code: s };
  if (s === 429) return { ok: false, mod_status: "rate_limited", http_code: s };

  // Truthfulness: 400/422 do NOT prove authority here. Mark indeterminate.
  if (s === 400 || s === 422) {
    return { ok: false, mod_status: "indeterminate", http_code: s, note: "ban_probe_validation_error" };
  }

  if (s >= 500) return { ok: false, mod_status: "error", http_code: s };
  if (s > 0) return { ok: false, mod_status: "error", http_code: s };

  return { ok: false, mod_status: "unknown", http_code: 0 };
}

// -----------------------------
// Fetch helpers (hard timeout)
// -----------------------------
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);

  try {
    return await fetch(url, { ...(options || {}), signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function deleteChatMessageProbe({ accessToken }) {
  const url = `${KICK_API_BASE}/chat/${NON_EXISTENT_MESSAGE_ID}`;
  const start = Date.now();

  try {
    const r = await fetchWithTimeout(
      url,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "*/*",
        },
      },
      PROBE_TIMEOUT_MS
    );

    let data = null;
    try {
      if (r.status !== 204) data = await r.json();
    } catch (_) {
      data = null;
    }

    return { status: r.status, data, latency_ms: Date.now() - start };
  } catch (err) {
    const msg = err?.message || String(err);
    const timedOut = /timeout|abort/i.test(msg);

    return {
      status: 0,
      data: null,
      latency_ms: Date.now() - start,
      error: msg,
      unreachable: true,
      timed_out: timedOut,
    };
  }
}

// -----------------------------
// Main API
// -----------------------------
/**
 * probeKickModerator()
 *
 * IMPORTANT:
 * - Deterministic probe requires ONLY: channelSlug + accessToken
 * - broadcasterUserId is ONLY required for legacy probe
 *
 * @param {object} params
 * @param {string} params.channelSlug
 * @param {number|string} [params.broadcasterUserId]
 * @param {string} [params.accessToken]
 * @param {boolean} [params.allowLegacy]
 * @returns {Promise<object>}
 */
export async function probeKickModerator({
  channelSlug,
  broadcasterUserId,
  accessToken,
  allowLegacy,
} = {}) {
  const channelId = normalizeChannelId(channelSlug);
  const bId = Number(broadcasterUserId);
  const legacyAllowed = Boolean(
    typeof allowLegacy === "boolean" ? allowLegacy : ALLOW_LEGACY_BY_DEFAULT
  );

  if (!channelId) {
    return {
      channelId: null,
      ok: false,
      mod_status: "unknown",
      http_code: 0,
      note: "missing channelSlug",
      probe: "none",
      from_cache: false,
    };
  }

  // Use cache (keyed by channel + token fingerprint + legacy mode)
  const key = cacheKey({ channelId, accessToken, allowLegacy: legacyAllowed });
  const cached = getCached(key);
  if (cached) {
    return {
      ...cached.value,
      from_cache: true,
    };
  }

  // -----------------------------
  // Deterministic probe (preferred)
  // -----------------------------
  if (accessToken) {
    const r = await deleteChatMessageProbe({ accessToken });

    const classified = classifyChatDelete(r.status);
    const out = {
      channelId,
      ...classified,
      probe: "chat_delete",
      from_cache: false,
      latency_ms: r.latency_ms,
      note: classified.note || r.error || undefined,
    };

    setCached(key, out, out.ok ? CACHE_TTL_OK_MS : CACHE_TTL_BAD_MS);
    return out;
  }

  // -----------------------------
  // No token → legacy probe decision
  // -----------------------------
  if (!legacyAllowed) {
    const out = {
      channelId,
      ok: false,
      mod_status: "indeterminate",
      http_code: 0,
      note: "no_access_token_and_legacy_disabled",
      probe: "none",
      from_cache: false,
    };
    setCached(key, out, CACHE_TTL_BAD_MS);
    return out;
  }

  // Legacy needs broadcasterUserId, period.
  if (!Number.isFinite(bId) || bId <= 0) {
    const out = {
      channelId,
      ok: false,
      mod_status: "unknown",
      http_code: 0,
      note: "missing broadcasterUserId (required for legacy probe)",
      probe: "none",
      from_cache: false,
    };
    setCached(key, out, CACHE_TTL_BAD_MS);
    return out;
  }

  // -----------------------------
  // Legacy fallback probe
  // -----------------------------
  const payload = {
    broadcaster_user_id: bId,
    user_id: bId, // safe self-target attempt
    duration_minutes: 1,
    reason: "probe",
  };

  let legacyStatus = 0;
  try {
    const legacy = await kickBanOrTimeout(payload);
    legacyStatus = legacy?.status || 0;
  } catch (e) {
    legacyStatus = 0;
  }

  const classifiedLegacy = classifyBanEndpoint(legacyStatus);
  const out = {
    channelId,
    ...classifiedLegacy,
    probe: "legacy_ban",
    from_cache: false,
  };

  setCached(key, out, out.ok ? CACHE_TTL_OK_MS : CACHE_TTL_BAD_MS);
  return out;
}
