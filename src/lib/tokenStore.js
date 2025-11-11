import { q } from './db.js';
import { v4 as uuid } from 'uuid';

// Upsert an account by kick_user_id; return { id, ... }
export async function upsertAccount({ kick_user_id, username }) {
  const id = uuid();
  const sql = `
    INSERT INTO accounts (id, kick_user_id, username, updated_at)
    VALUES ($1, $2, $3, now())
    ON CONFLICT (kick_user_id)
    DO UPDATE SET
      username   = EXCLUDED.username,
      updated_at = now()
    RETURNING id, kick_user_id, username
  `;
  const { rows } = await q(sql, [id, kick_user_id, username]);
  return rows[0];
}

export async function saveTokens(account_id, token) {
  const {
    access_token,
    refresh_token,
    scope = null,
    token_type = null,
    expires_in = 3600
  } = token;

  const now = new Date();
  const expires_at = new Date(now.getTime() + Math.max(expires_in - 60, 0) * 1000);

  // 1) Bridge any legacy row keyed by owner_id -> this account_id
  await q(
    `UPDATE kick_tokens
       SET account_id = $1, updated_at = now()
     WHERE owner_id = $2
       AND (account_id IS NULL OR account_id <> $1)`,
    [account_id, String(account_id)]
  );

  // 2) Upsert by account_id (modern canonical key)
  await q(
    `INSERT INTO kick_tokens (
        account_id, owner_id, access_token, refresh_token,
        scope, token_type, expires_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (account_id) DO UPDATE
       SET access_token  = EXCLUDED.access_token,
           refresh_token = COALESCE(EXCLUDED.refresh_token, kick_tokens.refresh_token),
           scope         = EXCLUDED.scope,
           token_type    = EXCLUDED.token_type,
           expires_at    = EXCLUDED.expires_at,
           updated_at    = now()`,
    [account_id, String(account_id), access_token, refresh_token, scope, token_type, expires_at]
  );
}

export async function latestTokens(account_id) {
  const { rows } = await q(
    `SELECT *
       FROM kick_tokens
      WHERE account_id = $1 OR owner_id = $2
      ORDER BY expires_at DESC NULLS LAST
      LIMIT 1`,
    [account_id, String(account_id)]
  );
  return rows[0];
}
