// src/moderationStore.js
import { q } from "./lib/db.js";

// Cache key: `${scraplet_user_id}:${platform}` -> rules[]
const moderationCache = new Map();

function normSlug(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase().replace(/^@+/, "");
  return s ? s : null;
}

export async function loadAllModerationRules() {
  console.log("[moderationStore] Loading all moderation rules...");

  const { rows } = await q(
    `
    SELECT
      id,
      scraplet_user_id,
      platform,
      rule_type,
      rule_value,
      action,
      duration_seconds,
      enabled,
      channel_slug,
      ignore_mods,
      priority
    FROM scrapbot_moderation_rules
    WHERE enabled = true
    ORDER BY priority ASC, id ASC
    `
  );

  moderationCache.clear();

  for (const r of rows) {
    const key = `${r.scraplet_user_id}:${(r.platform || "kick").toLowerCase()}`;
    if (!moderationCache.has(key)) moderationCache.set(key, []);

    // Normalize channel_slug once at load-time (covers '' and '@Scraplet' etc)
    r.channel_slug = normSlug(r.channel_slug);

    moderationCache.get(key).push(r);
  }

  console.log(
    `[moderationStore] Loaded ${rows.length} moderation rules (cached by user+platform)`
  );
}

export async function reloadModerationRulesForUser(scraplet_user_id, platform = "kick") {
  const plat = (platform || "kick").toLowerCase();
  const key = `${scraplet_user_id}:${plat}`;

  console.log(
    `[moderationStore] Reloading moderation rules for user=${scraplet_user_id} platform=${plat}...`
  );

  const { rows } = await q(
    `
    SELECT
      id,
      scraplet_user_id,
      platform,
      rule_type,
      rule_value,
      action,
      duration_seconds,
      enabled,
      channel_slug,
      ignore_mods,
      priority
    FROM scrapbot_moderation_rules
    WHERE enabled = true
      AND scraplet_user_id = $1
      AND lower(platform) = $2
    ORDER BY priority ASC, id ASC
    `,
    [scraplet_user_id, plat]
  );

  for (const r of rows) {
    r.channel_slug = normSlug(r.channel_slug);
  }

  moderationCache.set(key, rows);
  console.log(
    `[moderationStore] User ${scraplet_user_id} platform ${plat} has ${rows.length} moderation rules`
  );
}

export function getModerationRulesFor({ scraplet_user_id, platform = "kick", channelSlug = null }) {
  const plat = (platform || "kick").toLowerCase();
  const key = `${scraplet_user_id}:${plat}`;
  const rules = moderationCache.get(key) || [];

  const slug = normSlug(channelSlug);

  // channel-aware filtering:
  // - if rule has channel_slug: must match
  // - if rule channel_slug is null: global rule
  const filtered = rules.filter((r) => {
    const rslug = r.channel_slug ? normSlug(r.channel_slug) : null;
    if (!rslug) return true;
    if (!slug) return false;
    return rslug === slug;
  });

  if (process.env.VERBOSE_MODERATION_STORE === "true") {
    console.log("[moderationStore] getModerationRulesFor", {
      scraplet_user_id,
      platform: plat,
      channelSlug: slug,
      total: rules.length,
      filtered: filtered.length,
    });
  }

  return filtered;
}
