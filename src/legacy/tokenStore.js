// /var/www/scrapbot/src/lib/tokenStore.js
import { q } from "./db.js";

/**
 * Ensure minimal schema exists for accounts + tokens.
 * Idempotent: safe to call repeatedly.
 *
 * NOTE:
 * We do NOT attempt to ALTER existing tables here. In production your kick_tokens
 * table may have NOT NULL constraints (e.g. expires_at). Therefore saveTokens()
 * must never write NULL for expires_at.
 */
async function ensureSchema() {
  await q(`
    CREATE TABLE IF NOT EXISTS public.accounts (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kick_user_id text UNIQUE,
      username     text,
      created_at   timestamptz DEFAULT now(),
      updated_at   timestamptz DEFAULT now()
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS public.kick_tokens (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id      text,
      account_id    uuid REFERENCES public.accounts(id) ON DELETE CASCADE,
      scope         text,
      token_type    text,
      access_token  text,
      refresh_token text,
      expires_at    timestamptz,
      created_at    timestamptz DEFAULT now(),
      updated_at    timestamptz DEFAULT now()
    )
  `);
}

/**
 * Upsert account by Kick user id.
 */
export async function upsertAccount({ kick_user_id, username }) {
  await ensureSchema();

  const sql = `
    INSERT INTO public.accounts (kick_user_id, username)
    VALUES ($1, $2)
    ON CONFLICT (kick_user_id) DO UPDATE
      SET username = EXCLUDED.username,
          updated_at = now()
    RETURNING *;
  `;

  const { rows } = await q(sql, [kick_user_id, username]);
  return rows[0];
}

/**
 * Normalize expires_at for DB writes.
 * Priority:
 *  1) token.expires_in (seconds) -> now + expires_in
 *  2) token.expires_at (Date/string) -> parsed Date
 *  3) fallback -> now + 7200s (2 hours)
 *
 * IMPORTANT: must never return null/undefined.
 */
function computeExpiresAt(token) {
  const now = Date.now();

  // expires_in (seconds)
  const expiresInRaw = token?.expires_in ?? token?.expiresIn ?? null;
  const expiresIn = Number(expiresInRaw || 0);
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    return new Date(now + expiresIn * 1000);
  }

  // expires_at (date-ish)
  const expiresAtRaw = token?.expires_at ?? token?.expiresAt ?? null;
  if (expiresAtRaw) {
    const d = expiresAtRaw instanceof Date ? expiresAtRaw : new Date(expiresAtRaw);
    if (!Number.isNaN(d.getTime())) return d;
  }

  // Conservative fallback (Kick bot tokens commonly ~7200s)
  return new Date(now + 7200 * 1000);
}

/**
 * Save tokens for an account.
 *
 * Signature matches how we call it elsewhere:
 *   saveTokens(acct.id, { ...token, owner_id, scope: "..." })
 */
export async function saveTokens(account_id, token) {
  await ensureSchema();

  const owner_id = String(token?.owner_id || token?.user_id || "").trim();
  const scope = Array.isArray(token?.scope)
    ? token.scope.join(" ")
    : String(token?.scope || "").trim();

  const expires_at = computeExpiresAt(token);

  // NOTE:
  // Some legacy code passes empty strings; DB constraints may be NOT NULL.
  // We keep empty-string fallback to avoid undefined, but prefer real values.
  const token_type = token?.token_type || "Bearer";
  const access_token = token?.access_token || "";
  const refresh_token = token?.refresh_token || "";

  await q(
    `
    INSERT INTO public.kick_tokens (
      account_id,
      owner_id,
      scope,
      token_type,
      access_token,
      refresh_token,
      expires_at,
      updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7, now())
    ON CONFLICT (account_id) DO UPDATE
      SET owner_id      = EXCLUDED.owner_id,
          scope         = EXCLUDED.scope,
          token_type    = EXCLUDED.token_type,
          access_token  = EXCLUDED.access_token,
          refresh_token = EXCLUDED.refresh_token,
          -- Never allow expires_at to become NULL (or regress)
          expires_at    = COALESCE(EXCLUDED.expires_at, public.kick_tokens.expires_at),
          updated_at    = now()
    `,
    [account_id, owner_id, scope, token_type, access_token, refresh_token, expires_at]
  );

  return { account_id, owner_id, scope, expires_at };
}
