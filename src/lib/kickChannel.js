// /var/www/scrapbot/src/lib/kickChannel.js
import axios from 'axios';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

const http = axios.create({
  timeout: 8000,
  headers: {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://kick.com/',
  },
  // If Kick ever complains about TLS/HTTP2 oddities, uncomment:
  // httpAgent: new (await import('node:https')).Agent({ keepAlive: true }),
});

const CHANNEL_API = (slug) => `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`;
const CHATROOM_API = (id)  => `https://kick.com/api/v2/chatrooms/${id}`;
const CHANNEL_PAGE = (slug) => `https://kick.com/${encodeURIComponent(slug)}`;

// Very tolerant parser for HTML fallback
function extractChatroomIdFromHtml(html) {
  // Look for "chatroom_id":12345 or "chatroom":{"id":12345}
  const m = html.match(/"chatroom_id"\s*:\s*(\d+)/) || html.match(/"chatroom"\s*:\s*{\s*"id"\s*:\s*(\d+)/);
  return m ? String(m[1]) : null;
}

export async function resolveChannel(slug) {
  const s = String(slug).toLowerCase();
  let chatroomId = null;
  let pusherKey = null;
  let pusherCluster = 'mt1';
  let viewerWsUrl = null;

  // 1) Try JSON channel -> chatroom id
  try {
    const { data: channel } = await http.get(CHANNEL_API(s));
    chatroomId =
      channel?.chatroom?.id ??
      channel?.chatroom_id ??
      channel?.livestream?.chatroom?.id ??
      null;
  } catch (e) {
    // 403/5xx are common from server IPs; fall back to HTML scrape
  }

  // 2) Fallback: scrape the public channel page for chatroom id
  if (!chatroomId) {
    try {
      const { data: html } = await http.get(CHANNEL_PAGE(s), {
        headers: { 'Accept': 'text/html,application/xhtml+xml', 'User-Agent': UA, 'Referer': 'https://kick.com/' },
      });
      chatroomId = extractChatroomIdFromHtml(html);
    } catch {
      /* ignore */
    }
  }

  if (!chatroomId) {
    throw new Error(`Could not resolve chatroom id for slug ${s}`);
  }

  // 3) Try chatroom metadata (often has pusher key/cluster or viewer websocket URL)
  try {
    const { data: room } = await http.get(CHATROOM_API(chatroomId));
    pusherKey     = room?.pusher?.key || room?.pusher_key || null;
    pusherCluster = room?.pusher?.cluster || room?.pusher_cluster || pusherCluster;
    viewerWsUrl   = room?.websocket?.url || room?.viewer?.websocket_url || room?.socket_url || null;
  } catch {
    // Not fatal; we’ll use known defaults if needed
  }

  // 4) Sensible defaults when Kick omits values (based on what you saw in Network)
  if (!pusherKey) {
    // Kick rotates keys; prefer the one you saw most recently
    pusherKey = '73aa60a071d0943a6b3e';
  }
  if (!pusherCluster) pusherCluster = 'mt1';

  return {
    slug: s,
    chatroomId: String(chatroomId),
    pusherKey,
    pusherCluster,
    viewerWsUrl, // may be null; when present it’s usually best
  };
}
