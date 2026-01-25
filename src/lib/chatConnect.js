// src/lib/chatConnect.js
// Kick chat connection (Pusher) – NO OAuth, NO DB endpoints

import WebSocket from 'ws';
import Pusher from 'pusher-js';
import { resolveChannel } from './kickChannel.js';

if (typeof global.WebSocket === 'undefined') {
  global.WebSocket = WebSocket;
}

function stringify(x, n = 900) {
  try {
    const s = typeof x === 'string' ? x : JSON.stringify(x);
    return s.length > n ? s.slice(0, n) + '…' : s;
  } catch {
    return String(x).slice(0, n);
  }
}

export async function connectChannel(slug, { onEvent } = {}) {
  const info = await resolveChannel(slug);
  const {
    slug: resolvedSlug,
    chatroomId,
    pusherKey,
    pusherCluster,
    viewerWsUrl,
  } = info;

  if (!chatroomId) {
    throw new Error(
      `[chatConnect] resolveChannel did not return chatroomId for slug=${slug}`
    );
  }
  if (!pusherKey) {
    throw new Error(
      `[chatConnect] resolveChannel did not return pusherKey for slug=${slug}`
    );
  }

  const cluster = pusherCluster || 'mt1';

  let wsHost = undefined;
  let wsPort = undefined;
  let wssPort = undefined;

  if (viewerWsUrl) {
    try {
      const u = new URL(viewerWsUrl);
      const isSecure = u.protocol === 'wss:';
      const port = u.port
        ? Number(u.port)
        : isSecure
        ? 443
        : 80;

      wsHost = u.hostname;
      if (isSecure) {
        wssPort = port;
      } else {
        wsPort = port;
      }
    } catch (err) {
      console.warn(
        '[chatConnect] failed to parse viewerWsUrl',
        viewerWsUrl,
        err?.message || err
      );
    }
  }

  console.log(
    '[chatConnect] connecting',
    resolvedSlug,
    'chatroomId=',
    chatroomId,
    'cluster=',
    cluster,
    'wsHost=',
    wsHost || '(default)'
  );

  const pusher = new Pusher(pusherKey, {
    cluster,
    wsHost,
    wsPort,
    wssPort,
    forceTLS: true,
    enabledTransports: ['ws', 'wss'],
    disableStats: true,
  });

  pusher.connection.bind('state_change', (state) => {
    console.log(
      '[chatConnect] pusher state',
      resolvedSlug,
      stringify(state)
    );
  });

  pusher.connection.bind('error', (err) => {
    console.warn(
      '[chatConnect] pusher error',
      resolvedSlug,
      stringify(err)
    );
  });

  const channels = [
    `chatrooms.${chatroomId}.v2`,
    `chatrooms.${chatroomId}`,
    `chatrooms.${chatroomId}.v1`,
  ];

  for (const name of channels) {
    const ch = pusher.subscribe(name);

    // main chat messages
    ch.bind('App\\Events\\ChatMessageEvent', (data) => {
      if (!onEvent) return;
      try {
        onEvent({
          source: 'pusher',
          slug: resolvedSlug,
          chatroomId,
          event: 'App\\Events\\ChatMessageEvent',
          msg: data,
        });
      } catch (err) {
        console.error(
          '[chatConnect] onEvent error (chatmessage)',
          resolvedSlug,
          stringify(err)
        );
      }
    });

    // everything else
    ch.bind_global((eventName, data) => {
      if (!onEvent) return;
      if (eventName === 'App\\Events\\ChatMessageEvent') return;

      try {
        onEvent({
          source: 'pusher',
          slug: resolvedSlug,
          chatroomId,
          event: eventName,
          msg: data,
        });
      } catch (err) {
        console.error(
          '[chatConnect] onEvent error (global)',
          resolvedSlug,
          eventName,
          stringify(err)
        );
      }
    });
  }

  // wsSupervisor only cares that there's a .pusher to disconnect
  return { kind: 'single-pusher', pusher };
}
