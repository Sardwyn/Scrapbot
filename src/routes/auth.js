// /var/www/scrapbot/src/routes/auth.js
import express from 'express';
import { v4 as uuid } from 'uuid';
import { q } from '../lib/db.js';
import { startAuthUrl, newVerifier, exchangeCodeForToken } from '../lib/kickAuth.js';
import { upsertAccount, saveTokens } from '../lib/tokenStore.js';

const router = express.Router();

/**
 * GET /auth/kick/start?slug=<channel>
 * - Generates state+verifier
 * - Stashes in oauth_states
 * - Redirects to Kick authorize URL
 */
router.get('/auth/kick/start', async (req, res, next) => {
  try {
    const slug = (req.query.slug || '').toString().trim() || null;

    const state = uuid();
    const verifier = newVerifier();

    // ensure table exists (safe if already there)
    await q(`
      create table if not exists oauth_states (
        state uuid primary key,
        verifier text not null,
        created_at timestamptz default now()
      )
    `);

    await q(
      `insert into oauth_states(state, verifier) values ($1,$2)
       on conflict (state) do update set verifier = excluded.verifier, created_at = now()`,
      [state, verifier]
    );

    const url = startAuthUrl({ state, verifier, slug });
    return res.redirect(url);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /auth/kick/callback?code=...&state=...
 * - Validates state
 * - Exchanges code for tokens
 * - Upserts account (by Kick user id) and saves tokens
 * - Deletes consumed state
 */
router.get('/auth/kick/callback', async (req, res, next) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) throw new Error('Missing code or state');

    // fetch and consume verifier
    const { rows } = await q(`select verifier from oauth_states where state = $1`, [state]);
    if (!rows.length) throw new Error('Invalid or expired state');
    const verifier = rows[0].verifier;

    // Kick token exchange
    const token = await exchangeCodeForToken({ code, verifier });

    // If you have a "whoami" call to Kick, do it here to get user id/username.
    // For now, use token fields if available; otherwise mock minimal.
    // Example (pseudo): const me = await getKickUser(token.access_token);
    // Fallback minimal:
    const kick_user_id = String(token.owner_id || token.user_id || 'unknown');
    const username = String(token.username || 'unknown');

    // Upsert account and save tokens
    const acct = await upsertAccount({ kick_user_id, username });
    await saveTokens(acct.id, token);

    // consume state
    await q(`delete from oauth_states where state = $1`, [state]);

    // Redirect to a success page (adjust to your dashboard route)
    return res.redirect('/auth/success');
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send('OAuth callback error. Check server logs.');
  }
});

export default router;
