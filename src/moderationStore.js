// src/moderationStore.js
import pg from "pg";

const { Pool } = pg;

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

// Cache key: `${scraplet_user_id}:${platform}` -> rules[]
const moderationCache = new Map();

function normSlug(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase().replace(/^@+/, "");
  return s ? s : null;
}

export async function loadAllModerationRules() {
  console.log("[moderationStore] Loading all moderation rules...");

  const { rows } = await db.query(`
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
  `);

  moderationCache.clear();

  for (const r of rows) {
    const key = `${r.scraplet_user_id}:${(r.platform || "kick").toLowerCase()}`;
    if (!moderationCache.has(key)) moderationCache.set(key, []);

    // Normalize channel_slug once at load-time (covers '' and '@Scraplet' etc)
    r.channel_slug = normSlug(r.channel_slug);

    moderationCache.get(key).push(r);
  }

  console.log(`[moderationStore] Loaded ${rows.length} moderation rules (cached by user+platform)`);
}

export async function reloadModerationRulesForUser(scraplet_user_id, platform = "kick") {
  const plat = (platform || "kick").toLowerCase();
  const key = `${scraplet_user_id}:${plat}`;

  console.log(`[moderationStore] Reloading moderation rules for user=${scraplet_user_id} platform=${plat}...`);

  const { rows } = await db.query(
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
  console.log(`[moderationStore] User ${scraplet_user_id} platform ${plat} has ${rows.length} moderation rules`);
}

/**
 * Get moderation rules for a user+platform, optionally scoped to a channel.
 *
 * Supports both call styles:
 *   getModerationRulesFor(scraplet_user_id, platform?)
 *   getModerationRulesFor({ scraplet_user_id, platform, channelSlug/channel_slug })
 */
export function getModerationRulesFor(arg1, arg2 = "kick") {
  let scraplet_user_id = null;
  let platform = "kick";
  let channelSlug = null;

  if (typeof arg1 === "object" && arg1) {
    scraplet_user_id = Number(arg1.scraplet_user_id ?? arg1.scrapletUserId ?? NaN);
    platform = String(arg1.platform || "kick").toLowerCase();
    channelSlug = arg1.channelSlug ?? arg1.channel_slug ?? null;
  } else {
    scraplet_user_id = Number(arg1 ?? NaN);
    platform = String(arg2 || "kick").toLowerCase();
    channelSlug = null;
  }

  const key = `${scraplet_user_id}:${platform}`;
  const allRules = moderationCache.get(key) || [];

  const chan = normSlug(channelSlug);

  // If channel isn't provided, return all rules for user+platform.
  // If channel is provided, include:
  //   - global rules (channel_slug null)
  //   - channel-specific rules (channel_slug === chan)
  const rules = !chan
    ? allRules
    : allRules.filter((r) => {
        const rChan = normSlug(r.channel_slug);
        if (!rChan) return true; // global
        return rChan === chan; // channel-specific match
      });

  console.log(
    "[moderationStore] getModerationRulesFor user=",
    { scraplet_user_id, platform, channelSlug: chan },
    "rules=",
    rules.length
  );

  return rules;
}
