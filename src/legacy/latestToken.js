import { q } from './db.js';
export async function latestAccessToken() {
  const { rows } = await q(
    `select access_token from kick_tokens
      where account_id is not null
      order by expires_at desc nulls last
      limit 1`
  );
  return rows[0]?.access_token || null;
}
