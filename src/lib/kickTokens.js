// /src/lib/kickTokens.js
import { Pool } from 'pg';

let pool = null;
function getPool() {
  if (!pool) {
    const cs = process.env.SCRAPBOT_DB_URL || process.env.DATABASE_URL;
    if (!cs) throw new Error('SCRAPBOT_DB_URL (or DATABASE_URL) is not set');
    pool = new Pool({ connectionString: cs });
  }
  return pool;
}

/**
 * Upsert tokens keyed by account_id (canonical).
 * accepts: { user_id, access_token, refresh_token, expires_at, scope, role, owner_user_id, channel_slug }
 * Only fields actually present in public.kick_tokens are written.
 */
export async function upsertTokens({
  user_id,
  access_token,
  refresh_token,
  expires_at,
  scope = null,
  role = null,            // ignored in DB; kept for API symmetry
  owner_user_id = null,   // ignored in DB; kept for API symmetry
  channel_slug = null     // optional convenience; not stored here
}) {
  const pool = getPool();

  // Optionally resolve account_id by channel_slug if caller only has slug
  let accountId = user_id;
  if (!accountId && channel_slug) {
    const { rows: acc } = await pool.query(
      `select a.id
         from public.channels ch
         join public.accounts a on a.kick_user_id = a.kick_user_id -- placeholder join; caller should pass user_id if possible
        where lower(ch.channel_slug)=lower($1)
        limit 1`,
      [channel_slug]
    );
    accountId = acc[0]?.id || null;
  }
  if (!accountId) throw new Error('upsertTokens requires user_id (account_id)');

  const q = `
    insert into public.kick_tokens (
      account_id, owner_id, access_token, refresh_token,
      scope, token_type, expires_at, updated_at
    )
    values ($1, $2, $3, $4, $5, NULL, $6, now())
    on conflict (account_id) do update set
      access_token  = excluded.access_token,
      refresh_token = coalesce(excluded.refresh_token, public.kick_tokens.refresh_token),
      scope         = excluded.scope,
      expires_at    = excluded.expires_at,
      updated_at    = now()
    returning *`;
  const params = [accountId, String(accountId), access_token, refresh_token, scope, expires_at instanceof Date ? expires_at.toISOString() : expires_at];
  const { rows } = await pool.query(q, params);
  return rows[0];
}

/**
 * Get the latest token for a channel or id.
 * ownerId may be a slug ('scraplet'), a channel_id (text), an account UUID, or the special 'scrapbot'.
 * Resolution order: slug → channels.channel_id → kick_tokens by channel_id → by account_id/owner_id.
 */
export async function getTokens(ownerId) {
  const pool = getPool();
  const key = String(ownerId || '').trim();
  if (!key) return null;

  // Try slug → channel_id
  const { rows: ch } = await pool.query(
    `select channel_id from public.channels where lower(channel_slug)=lower($1) limit 1`,
    [key]
  );
  if (ch[0]?.channel_id) {
    const { rows } = await pool.query(
      `select * from public.kick_tokens where channel_id=$1 order by expires_at desc nulls last limit 1`,
      [ch[0].channel_id]
    );
    if (rows[0]) return rows[0];
  }

  // Try direct channel_id, then account_id/owner_id fallback
  const { rows } = await pool.query(
    `select *
       from public.kick_tokens
      where channel_id = $1
         or account_id::text = $1
         or owner_id = $1
      order by expires_at desc nulls last
      limit 1`,
    [key]
  );
  return rows[0] || null;
}
