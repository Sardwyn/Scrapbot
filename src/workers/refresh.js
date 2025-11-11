// /var/www/scrapbot/src/workers/refresh.js

import dotenv from 'dotenv';
dotenv.config();

import { pool, q } from '../lib/db.js';
import { refreshToken } from '../lib/kickAuth.js';
import { saveTokens } from '../lib/tokenStore.js';

const WINDOW_MS   = Number(process.env.REFRESH_WINDOW_MS   || 10 * 60 * 1000); // 10m
const INTERVAL_MS = Number(process.env.REFRESH_INTERVAL_MS || 60 * 1000);      // 1m
const LOCK_ID     = Number(process.env.REFRESH_LOCK_ID     || 9112025);        // advisory lock

async function withLock(fn) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS got;', [LOCK_ID]);
    if (!rows?.[0]?.got) return; // another worker is running
    await fn();
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1);', [LOCK_ID]); } catch {}
    client.release();
  }
}

async function tick() {
  const now = new Date();
  const cutoff = new Date(now.getTime() + WINDOW_MS);

  // Only refresh tokens from the new flow (must have account_id)
  const { rows } = await q(
    `select owner_id, account_id, refresh_token, expires_at
       from kick_tokens
      where account_id is not null
        and refresh_token is not null
        and (expires_at is null or expires_at <= $1)`,
    [cutoff]
  );

  if (!rows.length) return;

  for (const row of rows) {
    try {
      const t = await refreshToken(row.refresh_token); // { access_token, refresh_token, expires_in, ... }
      const acctId = row.account_id || row.owner_id;   // legacy safety
      await saveTokens(acctId, t);

      const newExp = new Date(Date.now() + (Number(t.expires_in || 3600) - 60) * 1000);
      console.log(`[refresh] ok for account ${acctId} exp-> ${newExp.toISOString()}`);
    } catch (e) {
      const details = e?.response?.data || e?.message || String(e);
      console.error('[refresh] failed for', row.account_id || row.owner_id, details);
    }
  }
}

console.log('Token refresh worker running…');
withLock(() => tick()).catch(() => {});

const timer = setInterval(() => {
  withLock(() => tick()).catch(() => {});
}, INTERVAL_MS);

// graceful shutdown & error visibility
process.on('SIGINT',  () => { clearInterval(timer); process.exit(0); });
process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException',  (e) => console.error('[uncaughtException]', e));
