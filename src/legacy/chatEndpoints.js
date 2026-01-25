// /src/lib/chatEndpoints.js
import { q } from './db.js';

export async function getPreferredEndpoint({ chatroomId, slug }) {
  if (!chatroomId && !slug) return null;
  if (chatroomId) {
    const { rows } = await q(
      `select app_key, cluster from public.chat_endpoints where chatroom_id=$1`,
      [chatroomId]
    );
    if (rows[0]) return rows[0];
  }
  if (slug) {
    const { rows } = await q(
      `select app_key, cluster from public.chat_endpoints
       where lower(channel_slug)=lower($1) limit 1`,
      [slug]
    );
    return rows[0] || null;
  }
  return null;
}

export async function savePreferredEndpoint({ chatroomId, slug, appKey, cluster, ok }) {
  if (!chatroomId || !appKey || !cluster) return;
  await q(
    `insert into public.chat_endpoints (chatroom_id, channel_slug, app_key, cluster, success_count, failure_count, updated_at)
     values ($1,$2,$3,$4, $5,$6, now())
     on conflict (chatroom_id) do update
       set app_key=$3, cluster=$4,
           success_count = public.chat_endpoints.success_count + $5,
           failure_count = public.chat_endpoints.failure_count + $6,
           channel_slug = coalesce($2, public.chat_endpoints.channel_slug),
           updated_at = now()`,
    [chatroomId, slug || null, appKey, cluster, ok ? 1 : 0, ok ? 0 : 1]
  );
}
