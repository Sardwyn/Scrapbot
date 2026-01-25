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
 * Helper: resolve channel_slug → { account_id }
 * Falls back to accounts.owner_slug if present in your schema.
 */
async function resolveChannelBySlug(slug) {
  const p = getPool();
  const key = String(slug || '').trim().toLowerCase();
  if (!key) return null;

  // channels.channel_slug -> channels.account_id
  const { rows: ch } = await p.query(
    `select account_id
       from public.channels
      where lower(channel_slug)=lower($1)
      limit 1`,
    [key]
  );
  if (ch[0]?.account_id) return { account_id: ch[0].account_id };

  // optional fallback: accounts.owner_slug -> accounts.id
  try {
    const { rows: ac } = await p.query(
      `select id from public.accounts where lower(owner_slug)=lower($1) limit 1`,
      [key]
    );
    if (ac[0]?.id) return { account_id: ac[0].id };
  } catch {
    // if owner_slug doesn't exist in your schema, ignore
  }

  return null;
}

/**
 * Upsert tokens keyed by account_id (canonical).
 * accepts: { user_id, access_token, refresh_token, expires_at, scope, role, owner_user_id, channel_slug }
 * Only writes columns that exist: account_id, access_token, refresh_token, scope, token_type, expires_at, updated_at
 */
export async function upsertTokens({
  user_id,             // -> account_id (preferred key)
  access_token,
  refresh_token,
  expires_at,          // Date or ISO string
  scope = null,
  role = null,         // ignored; API symmetry only
  owner_user_id = null,// ignored; API symmetry only
  channel_slug = null  // used only to resolve account_id if user_id not provided
}) {
  const p = getPool();

  let accountId = user_id || null;
  if (!accountId && channel_slug) {
    const resolved = await resolveChannelBySlug(channel_slug);
    accountId = resolved?.account_id || null;
  }
  if (!accountId) {
    throw new Error('upsertTokens requires user_id (account_id) or resolvable channel_slug');
  }

  const expiresIso = expires_at instanceof Date ? expires_at.toISOString() : String(expires_at || '');

  // UPDATE first (so we don't rely on a specific unique index), then INSERT if nothing updated
  const upd = await p.query(
    `update public.kick_tokens
        set access_token = $2,
            refresh_token = coalesce($3, refresh_token),
            scope = $4,
            expires_at = $5,
            updated_at = now()
      where account_id = $1`,
    [accountId, access_token, refresh_token, scope, expiresIso]
  );

  if (upd.rowCount > 0) {
    const { rows } = await p.query(
      `select * from public.kick_tokens where account_id = $1 limit 1`,
      [accountId]
    );
    return rows[0];
  }

  const { rows } = await p.query(
    `insert into public.kick_tokens (
        account_id, access_token, refresh_token, scope, token_type, expires_at, updated_at
     ) values ($1,$2,$3,$4,NULL,$5,now())
     returning *`,
    [accountId, access_token, refresh_token, scope, expiresIso]
  );
  return rows[0];
}

/**
 * Get latest token row:
 * - If ownerIdOrSlug supplied:
 *     • UUID → treat as account_id
 *     • slug → resolve via channels.channel_slug → account_id
 *     • (optional) owner_slug → accounts.id
 * - If not supplied: return newest overall (updated_at/ expires_at)
 */
export async function getTokens(ownerIdOrSlug) {
  const p = getPool();
  const key = String(ownerIdOrSlug || '').trim();

  if (key) {
    // UUID?
    if (/^[0-9a-f-]{36}$/i.test(key)) {
      const { rows } = await p.query(
        `select * from public.kick_tokens
          where account_id = $1
          order by updated_at desc, expires_at desc nulls last
          limit 1`,
        [key]
      );
      return rows[0] || null;
    }

    // slug -> account_id
    const resolved = await resolveChannelBySlug(key);
    if (resolved?.account_id) {
      const { rows } = await p.query(
        `select * from public.kick_tokens
          where account_id = $1
          order by updated_at desc, expires_at desc nulls last
          limit 1`,
        [resolved.account_id]
      );
      return rows[0] || null;
    }
  }

  // fallback: newest row overall
  const { rows } = await p.query(
    `select * from public.kick_tokens
      order by updated_at desc, expires_at desc nulls last
      limit 1`
  );
  return rows[0] || null;
}
