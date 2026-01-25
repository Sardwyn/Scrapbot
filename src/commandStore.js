// /var/www/scrapbot/src/commandStore.js
//
// Loads enabled chat commands from scrapbot_clean and serves them to inbound chat processing.
// IMPORTANT: Uses the shared DB pool (src/lib/db.js). Do NOT create a new Pool here.

import db from "./lib/db.js";

// Cache by account_id (as your current implementation does)
let commandCache = new Map();
let lastLoadedAt = null;

export async function loadAllCommands() {
  console.log("[commandStore] Loading all commands...");

  const sql = `
    SELECT
      c.id,
      c.account_id,
      c.name,
      c.trigger_pattern,
      c.trigger_type,
      c.response_type,
      c.response_payload,
      c.role,
      c.cooldown_seconds,
      c.enabled,
      a.platform,
      a.channel_id
    FROM public.scrapbot_commands c
    JOIN public.scrapbot_accounts a ON c.account_id = a.id
    WHERE c.enabled = true
  `;

  const { rows } = await db.query(sql);

  // Reset cache
  commandCache = new Map();
  for (const row of rows) {
    const existing = commandCache.get(row.account_id) || [];
    existing.push(row);
    commandCache.set(row.account_id, existing);
  }

  lastLoadedAt = new Date();
  console.log(`[commandStore] Loaded ${rows.length} commands (cached by account_id)`);
}

/**
 * TEMP behavior: return all commands (your file already did this).
 * Once stable, we should filter by (platform, channelId) again.
 */
export function getCommandsFor(platform, channelId) {
  const plat = String(platform || "kick").toLowerCase().trim();
  const ch = String(channelId || "").toLowerCase().trim();

  if (!ch) return [];

  const all = Array.from(commandCache.values()).flat();

  const filtered = all.filter((c) => {
    const cPlat = String(c.platform || "").toLowerCase().trim();
    const cCh = String(c.channel_id || "").toLowerCase().trim();
    return cPlat === plat && cCh === ch;
  });

  console.log(
    "[commandStore] getCommandsFor",
    { platform: plat, channelId: ch, returning: filtered.length, lastLoadedAt: lastLoadedAt ? lastLoadedAt.toISOString() : "never" }
  );

  return filtered;
}

