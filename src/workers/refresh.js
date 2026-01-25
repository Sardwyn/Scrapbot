// /var/www/scrapbot/src/workers/refresh.js
//
// BOT TOKEN REFRESH WORKER (Scrapbot-only)
//
// IMPORTANT:
// - This worker REFRESHES ONLY the Scrapbot bot token in kick_tokens_bot (id=1)
// - It MUST NOT read/write user tokens (kick_tokens). Dashboard owns those.
// - Actual refresh + DB update is handled by ../lib/refreshKick.js

import { pool, q } from "../lib/db.js";
import { refreshIfNeeded } from "../lib/refreshKick.js";

const WINDOW_MS = Number(process.env.BOT_REFRESH_WINDOW_MS || 10 * 60 * 1000); // 10m
const INTERVAL_MS = Number(process.env.BOT_REFRESH_INTERVAL_MS || 60 * 1000); // 1m
const LOCK_ID = Number(process.env.BOT_REFRESH_LOCK_ID || 9112025); // advisory lock

async function withLock(fn) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS got;", [LOCK_ID]);
    if (!rows?.[0]?.got) return false; // another tick is running
    await fn();
    return true;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1);", [LOCK_ID]);
    } catch {}
    client.release();
  }
}

async function getBotTokenMeta() {
  const { rows } = await q(
    `
    select id, expires_at, updated_at
    from public.kick_tokens_bot
    where id = 1
    limit 1
    `
  );
  const row = rows?.[0] || null;
  return {
    hasRow: !!row,
    expiresAt: row?.expires_at ? new Date(row.expires_at) : null,
    updatedAt: row?.updated_at ? new Date(row.updated_at) : null,
  };
}

async function tick() {
  const meta = await getBotTokenMeta();

  if (!meta.hasRow) {
    console.warn("[botRefresh] no kick_tokens_bot row (id=1). Bot OAuth not completed?");
    return { did: false, reason: "missing_row" };
  }

  const now = Date.now();
  const cutoff = now + WINDOW_MS;

  // Only attempt refresh if expiring soon (or missing expiry)
  if (meta.expiresAt && meta.expiresAt.getTime() > cutoff) {
    return { did: false, reason: "not_due", expires_at: meta.expiresAt.toISOString() };
  }

  // refreshIfNeeded() is bot-only and persists to kick_tokens_bot internally.
  await refreshIfNeeded("bot");

  const after = await getBotTokenMeta();
  return {
    did: true,
    reason: "refreshed_or_checked",
    expires_at: after.expiresAt ? after.expiresAt.toISOString() : null,
    updated_at: after.updatedAt ? after.updatedAt.toISOString() : null,
  };
}

export function startRefreshWorker() {
  console.log("[botRefresh] worker starting", {
    intervalMs: INTERVAL_MS,
    windowMs: WINDOW_MS,
    lockId: LOCK_ID,
  });

  let timer = null;
  let inFlight = false;

  const run = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await withLock(async () => {
        const r = await tick();
        if (r?.did) {
          console.log("[botRefresh] ok", {
            expires_at: r.expires_at,
            updated_at: r.updated_at,
          });
        }
      });
    } catch (e) {
      console.error("[botRefresh] tick failed", e?.message || e);
    } finally {
      inFlight = false;
    }
  };

  // run soon after boot, then interval
  run().catch(() => {});
  timer = setInterval(() => run().catch(() => {}), INTERVAL_MS);

  return {
    running: true,
    stop: () => {
      try {
        if (timer) clearInterval(timer);
      } catch {}
      timer = null;
      console.log("[botRefresh] worker stopped");
    },
  };
}
