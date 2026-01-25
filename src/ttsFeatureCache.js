// /src/ttsFeatureCache.js
const cache = new Map();

const TTL_ENABLED_MS = 30_000;
const TTL_CONFIRM_MS = 3_000;
const TTL_SETTINGS_MS = 5_000;

async function fetchFeature(scrapletUserId, platform, channelSlug) {
  const base = process.env.DASHBOARD_INTERNAL_URL || "http://127.0.0.1:3000";
  const key = process.env.DASHBOARD_INTERNAL_KEY || "";

  const qs = new URLSearchParams();
  qs.set("userId", String(scrapletUserId));
  qs.set("platform", platform || "kick");
  if (channelSlug) qs.set("channel", channelSlug);

  const r = await fetch(`${base}/dashboard/api/internal/features/free-tts?${qs.toString()}`, {
    headers: { "x-scraplet-internal-key": key },
  });

  if (!r.ok) {
    return {
      enabled: false,
      chatConfirmations: false,
      tts: null,
      blacklist: [],
    };
  }

  const data = await r.json().catch(() => null);
  return {
    enabled: data?.enabled === true,
    chatConfirmations: data?.chatConfirmations === true,
    tts: data?.tts || null,
    blacklist: Array.isArray(data?.blacklist) ? data.blacklist : [],
  };
}

function getHit(id) {
  return cache.get(id) || null;
}

export async function getFreeTTSFeature({ scrapletUserId, platform = "kick", channelSlug = "" }) {
  const now = Date.now();
  const hit = getHit(scrapletUserId);

  if (hit && now - hit.tsSettings < TTL_SETTINGS_MS) return hit;

  const feature = await fetchFeature(scrapletUserId, platform, channelSlug);

  const next = {
    enabled: feature.enabled,
    chatConfirmations: feature.chatConfirmations,
    tts: feature.tts,
    blacklist: (feature.blacklist || []).map((x) => String(x || "").toLowerCase()).filter(Boolean),
    tsEnabled: hit?.tsEnabled || now,
    tsConfirm: hit?.tsConfirm || now,
    tsSettings: now,
  };

  cache.set(scrapletUserId, next);
  return next;
}

export async function isFreeTTSEnabled(scrapletUserId) {
  const now = Date.now();
  const hit = getHit(scrapletUserId);
  if (hit && now - hit.tsEnabled < TTL_ENABLED_MS) return hit.enabled;

  const feature = await fetchFeature(scrapletUserId, "kick", "");
  const next = {
    enabled: feature.enabled,
    chatConfirmations: feature.chatConfirmations,
    tts: feature.tts,
    blacklist: [],
    tsEnabled: now,
    tsConfirm: now,
    tsSettings: now,
  };
  cache.set(scrapletUserId, next);
  return feature.enabled;
}

export async function isFreeTTSChatConfirmationsEnabled(scrapletUserId) {
  const now = Date.now();
  const hit = getHit(scrapletUserId);
  if (hit && now - hit.tsConfirm < TTL_CONFIRM_MS) return hit.chatConfirmations;

  const feature = await fetchFeature(scrapletUserId, "kick", "");
  const next = {
    enabled: feature.enabled,
    chatConfirmations: feature.chatConfirmations,
    tts: feature.tts,
    blacklist: [],
    tsEnabled: hit?.tsEnabled || now,
    tsConfirm: now,
    tsSettings: now,
  };
  cache.set(scrapletUserId, next);
  return feature.chatConfirmations;
}

export async function setFreeTTSEnabled(scrapletUserId, enabled) {
  const base = process.env.DASHBOARD_INTERNAL_URL || "http://127.0.0.1:3000";
  const key = process.env.DASHBOARD_INTERNAL_KEY || "";

  const r = await fetch(`${base}/dashboard/api/internal/features/free-tts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-scraplet-internal-key": key,
    },
    body: JSON.stringify({ userId: scrapletUserId, enabled: !!enabled }),
  });

  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`setFreeTTSEnabled failed: ${r.status} ${body}`);
  }

  const data = await r.json().catch(() => null);
  const now = Date.now();

  const next = {
    enabled: data?.enabled === true,
    chatConfirmations: data?.chatConfirmations === true,
    tts: data?.tts || null,
    blacklist: [],
    tsEnabled: now,
    tsConfirm: now,
    tsSettings: now,
  };

  cache.set(scrapletUserId, next);
  return next.enabled;
}
