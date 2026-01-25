// src/lib/kickBotTokens.js
import * as db from './db.js';

const q = db.q || db.default?.q;

const KICK_CLIENT_ID = process.env.KICK_CLIENT_ID || '';
const KICK_CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || '';
const KICK_TOKEN_URL =
  process.env.KICK_TOKEN_URL || 'https://id.kick.com/oauth/token';

/**
 * Get a valid bot access token for Scrapbot.
 * - Reads from scrapbot_clean.kick_tokens_bot (id=1)
 * - If expiring in <60s, refresh via Kick OAuth refresh_token flow
 * - Updates DB and returns fresh access_token
 */
export async function getBotAccessToken() {
  if (!KICK_CLIENT_ID || !KICK_CLIENT_SECRET) {
    throw new Error(
      '[kickBotTokens] KICK_CLIENT_ID / KICK_CLIENT_SECRET not set in Scrapbot .env'
    );
  }

  const { rows } = await q(
    `
    SELECT id, access_token, refresh_token, expires_at
      FROM kick_tokens_bot
     WHERE id = 1
    `
  );

  if (!rows.length) {
    throw new Error(
      '[kickBotTokens] No Kick bot tokens stored. Hit /admin/bot/kick/start and authorize the Scrapbot app.'
    );
  }

  const row = rows[0];
  const expiresAt = new Date(row.expires_at).getTime();
  const now = Date.now();

  // If we still have 60+ seconds, just use current token
  if (expiresAt - now > 60_000) {
    return row.access_token;
  }

  // Otherwise, refresh via Kick refresh_token flow
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: KICK_CLIENT_ID,
    client_secret: KICK_CLIENT_SECRET,
    refresh_token: row.refresh_token,
  });

  const resp = await fetch(KICK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `[kickBotTokens] refresh failed: ${resp.status} ${text}`
    );
  }

  const data = await resp.json();
  const newAccess = data.access_token;
  const newRefresh = data.refresh_token || row.refresh_token;
  const expiresIn = Number(data.expires_in || 0);
  const newScope = data.scope || null;
  const tokenType = data.token_type || null;

  if (!newAccess || !expiresIn) {
    throw new Error(
      `[kickBotTokens] bad refresh payload from Kick: ${JSON.stringify(
        data
      )}`
    );
  }

  const newExpiresAt = new Date(Date.now() + expiresIn * 1000);

  await q(
    `
    UPDATE kick_tokens_bot
       SET access_token = $2,
           refresh_token = $3,
           expires_at    = $4,
           scope         = COALESCE($5, scope),
           token_type    = COALESCE($6, token_type),
           updated_at    = now()
     WHERE id = $1
  `,
    [1, newAccess, newRefresh, newExpiresAt, newScope, tokenType]
  );

  console.log('[kickBotTokens] bot token refreshed');

  return newAccess;
}
