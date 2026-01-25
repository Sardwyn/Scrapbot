// src/routes/botKickAuth.js
// Scrapbot-owned BOT Kick OAuth (PKCE, stores into scrapbot_clean.kick_tokens_bot)

import express from 'express';
import crypto from 'crypto';
import * as db from '../lib/db.js';

const router = express.Router();
const q = db.q || db.default?.q;

// Simple PKCE store: state -> { verifier, createdAt }
const pkceStore = new Map();

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function newVerifier() {
  return b64url(crypto.randomBytes(32));
}

function challengeFromVerifier(verifier) {
  return b64url(
    crypto.createHash('sha256').update(verifier).digest()
  );
}

// Handy getter so changes to .env don't require code changes
function getBotConfig() {
  return {
    clientId: process.env.KICK_CLIENT_ID || '',
    clientSecret: process.env.KICK_CLIENT_SECRET || '',
    redirectUri:
      process.env.KICK_REDIRECT_URI ||
      'https://scrapbot.scraplet.store/admin/bot/kick/callback',
    authUrl:
      process.env.KICK_AUTH_URL ||
      'https://id.kick.com/oauth/authorize',
    tokenUrl:
      process.env.KICK_TOKEN_URL ||
      'https://id.kick.com/oauth/token',
    scope:
      process.env.KICK_SCOPE ||
      // bot needs to read/write chat and read channels/events.
      'chat:read chat:write channel:read events:subscribe',
  };
}

// Optional: admin gate. If you want to lock this down, set BOT_SETUP_SECRET
function assertBotSetupAllowed(req) {
  const expected = process.env.BOT_SETUP_SECRET;
  if (!expected) return; // no gate configured

  const provided =
    req.query.key || req.headers['x-bot-setup-key'];
  if (!provided || provided !== expected) {
    const err = new Error('Forbidden');
    err.statusCode = 403;
    throw err;
  }
}

// GET /admin/bot/kick/start
// Start OAuth for the *Scrapbot bot* identity.
router.get('/admin/bot/kick/start', async (req, res) => {
  try {
    assertBotSetupAllowed(req);

    const { clientId, redirectUri, authUrl, scope } = getBotConfig();

    if (!clientId || !redirectUri) {
      console.error(
        '[botAuth:start] Missing KICK_CLIENT_ID or KICK_REDIRECT_URI in Scrapbot .env'
      );
      return res
        .status(500)
        .send('Scrapbot Kick OAuth not configured (KICK_CLIENT_ID / KICK_REDIRECT_URI)');
    }

    const verifier = newVerifier();
    const chall = challengeFromVerifier(verifier);

    const state = crypto.randomUUID();
    const now = Date.now();

    pkceStore.set(state, { verifier, createdAt: now });
    setTimeout(() => pkceStore.delete(state), 10 * 60 * 1000);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope,
      state,
      code_challenge: chall,
      code_challenge_method: 'S256',
    });

    const url = `${authUrl}?${params.toString()}`;
    console.log('[botAuth:start] redirecting to', url);

    return res.redirect(url);
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('[botAuth:start] error', err);
    return res
      .status(status)
      .send(status === 403 ? 'Forbidden' : 'Scrapbot bot OAuth start failed');
  }
});

// GET /admin/bot/kick/callback
router.get('/admin/bot/kick/callback', async (req, res) => {
  const { clientId, clientSecret, redirectUri, tokenUrl } =
    getBotConfig();

  const { code, state, error, error_description } = req.query || {};

  console.log(
    '[botAuth:callback] ENTRY',
    'code present =',
    !!code,
    'state present =',
    !!state
  );

  if (error) {
    console.error(
      '[botAuth:callback] error from provider:',
      error,
      error_description || ''
    );
    return res
      .status(400)
      .send(`Kick OAuth error: ${error}: ${error_description || ''}`);
  }

  if (!code || !state) {
    console.error(
      '[botAuth:callback] missing code or state',
      req.query
    );
    return res
      .status(400)
      .send('Kick OAuth callback missing code or state');
  }

  const stateStr = state.toString();
  const pkce = pkceStore.get(stateStr);

  if (!pkce) {
    console.error(
      '[botAuth:callback] no PKCE data for state',
      stateStr
    );
    return res.status(400).send('Missing PKCE verifier for state');
  }

  pkceStore.delete(stateStr);

  try {
    // 1) Exchange code for tokens
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code_verifier: pkce.verifier,
      code: code.toString(),
    });

    const resp = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(
        '[botAuth:callback] token exchange failed',
        resp.status,
        text
      );
      return res
        .status(502)
        .send('Failed to exchange code for bot token');
    }

    const tokenData = await resp.json();
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    const expiresIn = Number(tokenData.expires_in || 0);
    const scope = tokenData.scope || null;
    const tokenType = tokenData.token_type || null;

    if (!accessToken || !refreshToken || !expiresIn) {
      console.error(
        '[botAuth:callback] bad token payload from Kick',
        tokenData
      );
      return res
        .status(502)
        .send('Invalid bot token response from Kick');
    }

    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    // 2) Upsert into scrapbot_clean.kick_tokens_bot
    await q(
      `
      INSERT INTO kick_tokens_bot (id, access_token, refresh_token, expires_at, scope, token_type)
      VALUES (1, $1, $2, $3, $4, $5)
      ON CONFLICT (id) DO UPDATE SET
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        expires_at   = EXCLUDED.expires_at,
        scope        = COALESCE(EXCLUDED.scope, kick_tokens_bot.scope),
        token_type   = COALESCE(EXCLUDED.token_type, kick_tokens_bot.token_type),
        updated_at   = now()
      `,
      [accessToken, refreshToken, expiresAt, scope, tokenType]
    );

    console.log('[botAuth:callback] stored bot tokens (id=1)');

    // 3) Simple success page
    return res.send(`
      <html>
        <head><title>Scrapbot OAuth completed</title></head>
        <body style="font-family: system-ui; background:#020617; color:#e5e7eb; padding:2rem;">
          <h1>Scrapbot OAuth completed ✅</h1>
          <p>Bot tokens have been saved to <code>scrapbot_clean.kick_tokens_bot</code>.</p>
          <p>You can close this window now.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('[botAuth:callback] error', err);
    return res.status(500).send('Scrapbot bot OAuth callback failed');
  }
});

// Optional: quick health/status endpoint
router.get('/admin/bot/kick/status', async (_req, res) => {
  try {
    const { rows } = await q(
      `SELECT id, expires_at, scope, token_type, updated_at
         FROM kick_tokens_bot
        WHERE id = 1`
    );

    if (!rows.length) {
      return res.json({
        ok: false,
        hasTokens: false,
        message: 'No bot tokens stored',
      });
    }

    const row = rows[0];
    return res.json({
      ok: true,
      hasTokens: true,
      expires_at: row.expires_at,
      scope: row.scope,
      token_type: row.token_type,
      updated_at: row.updated_at,
    });
  } catch (err) {
    console.error('[botAuth:status] error', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
