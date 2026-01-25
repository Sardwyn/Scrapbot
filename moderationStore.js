// src/moderationStore.js
import pg from "pg";

const { Pool } = pg;

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

// Cache key: `${scraplet_user_id}:${platform}` -> rules[]
const moderationCache = new Map();

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
      enabled
    FROM scrapbot_moderation_rules
    WHERE enabled = true
    ORDER BY id ASC
  `);

  moderationCache.clear();

  for (const r of rows) {
    const key = `${r.scraplet_user_id}:${(r.platform || "kick").toLowerCase()}`;
    if (!moderationCache.has(key)) moderationCache.set(key, []);
    moderationCache.get(key).push(r);
  }

  console.log(`[moderationStore] Loaded ${rows.length} moderation rules`);
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
      enabled
    FROM scrapbot_moderation_rules
    WHERE enabled = true
      AND scraplet_user_id = $1
      AND lower(platform) = $2
    ORDER BY id ASC
    `,
    [scraplet_user_id, plat]
  );

  moderationCache.set(key, rows);
  console.log(`[moderationStore] User ${scraplet_user_id} platform ${plat} has ${rows.length} moderation rules`);
}

export function getModerationRulesFor(scraplet_user_id, platform = "kick") {
  const plat = (platform || "kick").toLowerCase();
  const key = `${scraplet_user_id}:${plat}`;
  const rules = moderationCache.get(key) || [];

  console.log(
    "[moderationStore] getModerationRulesFor user=",
    scraplet_user_id,
    "platform=",
    plat,
    "rules=",
    rules.length
  );

  return rules;
}
