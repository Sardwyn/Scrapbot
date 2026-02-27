// src/lib/refreshKick.js
// BOT TOKEN ONLY — do not use for user tokens
// Bot-only Kick OAuth refresh for Scrapbot (uses scrapbot_clean.kick_tokens_bot)
// Dashboard owns user OAuth; Scrapbot owns bot OAuth
// This is part of this system: src/lib/refreshKick.js - src/workers/refresh.js - src/routes/botKickAuth.js (PKCE flow)


import axios from 'axios';
import { q } from './db.js';

const KICK_CLIENT_ID = process.env.KICK_CLIENT_ID;
const KICK_CLIENT_SECRET = process.env.KICK_CLIENT_SECRET;
const KICK_TOKEN_URL =
  process.env.KICK_TOKEN_URL || 'https://id.kick.com/oauth/token';

if (!KICK_CLIENT_ID || !KICK_CLIENT_SECRET) {
  console.warn(
    '[refreshKick] Missing KICK_CLIENT_ID or KICK_CLIENT_SECRET in env – bot token refresh will fail'
  );
}

// We keep a single row for the bot in kick_tokens_bot with id=1
async function loadBotTokensRow() {
  const { rows } = await q(
    `
      SELECT id, access_token, refresh_token, expires_at
      FROM kick_tokens_bot
      WHERE id = 1
    `,
    []
  );

  if (!rows.length) {
    throw new Error(
      '[refreshKick] No row found in kick_tokens_bot with id=1 (did you complete bot OAuth?)'
    );
  }

  return rows[0];
}

/**
 * Ensure we have a valid bot access token.
 *
 * Signature is kept compatible with existing callers:
 *   await refreshIfNeeded(key);
 *
 * `key` is ignored – there is only one bot token set for all channels.
 * Returns the current valid access token as a string.
 */
export async function refreshIfNeeded(_key) {
  const row = await loadBotTokensRow();

  const now = Date.now();
  const expiresAtMs = row.expires_at ? new Date(row.expires_at).getTime() : 0;

  // If token is valid for >60s, just use it
  if (expiresAtMs && expiresAtMs - now > 60_000) {
    return row.access_token;
  }

  console.log('[refreshKick] Bot token near expiry or missing – refreshing');

  if (!row.refresh_token) {
    throw new Error(
      '[refreshKick] No refresh_token stored for bot in kick_tokens_bot'
    );
  }
  if (!KICK_CLIENT_ID || !KICK_CLIENT_SECRET) {
    throw new Error(
      '[refreshKick] KICK_CLIENT_ID / KICK_CLIENT_SECRET not configured for bot'
    );
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: row.refresh_token,
    client_id: KICK_CLIENT_ID,
    client_secret: KICK_CLIENT_SECRET,
  });

  let resp;
  try {
    resp = await axios.post(KICK_TOKEN_URL, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15_000,
    });
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    console.error(
      '[refreshKick] refresh request failed',
      status,
      data || err.message
    );
    throw err;
  }

  const data = resp.data || {};
  const newAccess = data.access_token;
  const newRefresh = data.refresh_token || row.refresh_token;
  const expiresIn = Number(data.expires_in || 0);

  if (!newAccess) {
    console.error(
      '[refreshKick] refresh response missing access_token',
      data
    );
    throw new Error('Kick bot refresh response missing access_token');
  }

  const newExpiresAt = expiresIn
    ? new Date(Date.now() + expiresIn * 1000)
    : row.expires_at;

  await q(
    `
      UPDATE kick_tokens_bot
      SET
        access_token  = $1,
        refresh_token = $2,
        expires_at    = $3,
        updated_at    = now()
      WHERE id = 1
    `,
    [newAccess, newRefresh, newExpiresAt]
  );

  console.log(
    '[refreshKick] Stored refreshed bot token; expires in',
    expiresIn,
    'seconds'
  );

  return newAccess;
}

// Optional helper if you ever just want to read whatever is there
export async function getCurrentBotToken() {
  const row = await loadBotTokensRow();
  return row.access_token;
}
