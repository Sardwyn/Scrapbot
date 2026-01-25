// src/lib/kickChannel.js
// Resolve a Kick channel (slug -> chatroomId + Pusher connection info)
// Uses Kick's v2 APIs only. No DB access.

import axios from 'axios';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

const http = axios.create({
  timeout: 8000,
  headers: {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://kick.com/',
  },
});

const CHANNEL_API = (slug) =>
  `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`;

const CHATROOM_API = (chatroomId) =>
  `https://kick.com/api/v2/chatrooms/${encodeURIComponent(chatroomId)}`;

const CHANNEL_PAGE = (slug) =>
  `https://kick.com/${encodeURIComponent(slug)}`;

function extractChatroomIdFromHtml(html) {
  if (!html || typeof html !== 'string') return null;

  let m = html.match(/data-chatroom-id=["'](\d+)["']/i);
  if (m && m[1]) return m[1];

  m = html.match(/"chatroom_id"\s*:\s*(\d+)/i);
  if (m && m[1]) return m[1];

  m = html.match(/"chatroom"\s*:\s*{[^}]*"id"\s*:\s*(\d+)/i);
  if (m && m[1]) return m[1];

  return null;
}

export async function resolveChannel(slug) {
  const s = String(slug).toLowerCase();
  let chatroomId = null;
  let pusherKey = null;
  let pusherCluster = null;
  let viewerWsUrl = null;

  // 1) Try JSON v2 channel endpoint
  try {
    const { data: channel } = await http.get(CHANNEL_API(s));
    chatroomId =
      channel?.chatroom?.id ??
      channel?.chatroom_id ??
      channel?.livestream?.chatroom?.id ??
      null;
  } catch (err) {
    console.warn(
      '[kickChannel] CHANNEL_API failed for',
      s,
      err?.message || err
    );
  }

  // 2) Fallback: scrape the public channel page
  if (!chatroomId) {
    try {
      const { data: html } = await http.get(CHANNEL_PAGE(s), {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': UA,
          Referer: 'https://kick.com/',
        },
      });
      chatroomId = extractChatroomIdFromHtml(html);
    } catch (err) {
      console.warn(
        '[kickChannel] HTML scrape failed for',
        s,
        err?.message || err
      );
    }
  }

  if (!chatroomId) {
    throw new Error(`[kickChannel] Could not resolve chatroom id for slug=${s}`);
  }

  // 3) Chatroom metadata → Pusher info
  try {
    const { data: room } = await http.get(CHATROOM_API(chatroomId));
    pusherKey =
      room?.pusher?.key ??
      room?.pusher_key ??
      null;
    pusherCluster =
      room?.pusher?.cluster ??
      room?.pusher_cluster ??
      null;

    viewerWsUrl =
      room?.websocket?.url ??
      room?.viewer?.websocket_url ??
      room?.socket_url ??
      null;
  } catch (err) {
    console.warn(
      '[kickChannel] CHATROOM_API failed for chatroom',
      chatroomId,
      err?.message || err
    );
  }

  // 4) Fallbacks
  if (!pusherKey) {
    // update this if Kick rotates keys again
    pusherKey = '73aa60a071d0943a6b3e';
  }
  if (!pusherCluster) {
    pusherCluster = 'mt1';
  }

  return {
    slug: s,
    chatroomId: String(chatroomId),
    pusherKey,
    pusherCluster,
    viewerWsUrl,
  };
}
