import WebSocket from 'ws';
import Pusher from 'pusher-js';
import { resolveChannel } from './kickChannel.js';

if (typeof global.WebSocket === 'undefined') {
  global.WebSocket = WebSocket; // pusher-js needs this in Node
}

function stringify(x, n = 900) {
  try { const s = typeof x === 'string' ? x : JSON.stringify(x); return s.length > n ? s.slice(0, n) + '…' : s; }
  catch { return String(x).slice(0, n); }
}

export async function connectChannel(slug, { onEvent } = {}) {
  const info = await resolveChannel(slug);

  // 0) Manual override to test Kick viewer WS if you paste a token URL from DevTools
  if (process.env.KICK_VIEWER_WS_URL_OVERRIDE) {
    const url = process.env.KICK_VIEWER_WS_URL_OVERRIDE;
    const ws = new WebSocket(url);
    ws.on('open', () => console.log('[viewer-ws]', info.slug, 'open (override)'));
    ws.on('message', (buf) => {
      let msg; try { msg = JSON.parse(buf.toString()); } catch { msg = { raw: buf.toString() }; }
      onEvent && onEvent({ source: 'viewer', slug: info.slug, chatroomId: info.chatroomId, msg });
      console.log('[viewer-ws]', info.slug, 'msg', stringify(msg));
    });
    ws.on('close', (c) => console.log('[viewer-ws]', info.slug, 'close', c));
    ws.on('error', (e) => console.error('[viewer-ws]', info.slug, 'error', e?.message || e));
    return { kind: 'viewer', ws };
  }

  // 1) Build candidate Pusher endpoints: resolved + known alternates you observed
  //    Format: { key, cluster }
  const candidates = [];
  if (info.pusherKey) candidates.push({ key: info.pusherKey, cluster: info.pusherCluster || 'mt1' });

  // Known keys/clusters seen in the wild (from your Network tab)
  const KNOWN = [
    { key: '73aa60a071d0943a6b3e', cluster: 'mt1' }, // ws-mt1.pusher.com
    { key: '32cbd69e4b950bf97679', cluster: 'us2' }, // ws-us2.pusher.com
    { key: 'dd11c46dae0376080879', cluster: 'us3' }, // ws-us3.pusher.com
  ];

  // Avoid duplicates
  for (const k of KNOWN) {
    if (!candidates.find(c => c.key === k.key && c.cluster === k.cluster)) candidates.push(k);
  }

  const base = `chatrooms.${info.chatroomId}`;
  const channelNames = [base, `${base}.v2`];
  const handles = [];

  // 2) Spin up a Pusher connection for each candidate and subscribe to both channels
  for (const cand of candidates) {
    const p = new Pusher(cand.key, {
      cluster: cand.cluster,
      wsHost: `ws-${cand.cluster}.pusher.com`,
      forceTLS: true,
      enabledTransports: ['ws'],
      disableStats: true,
    });

    const bindings = [];

    p.connection.bind('connected', () => {
      console.log('[pusher]', info.slug, 'connected', { app: cand.key.slice(0,6)+'…', cluster: cand.cluster, channels: channelNames });
    });

    p.connection.bind('error', (err) => {
      console.error('[pusher]', info.slug, 'conn-error', { app: cand.key.slice(0,6)+'…', cluster: cand.cluster, err: err?.error || err });
    });

    for (const name of channelNames) {
      const ch = p.subscribe(name);
      const b = (eventName, data) => {
        console.log('[pusher]', info.slug, name, eventName, stringify(data));
        onEvent && onEvent({
          source: 'pusher',
          slug: info.slug,
          chatroomId: info.chatroomId,
          event: eventName,
          msg: data,
          app: cand.key,
          cluster: cand.cluster,
          channel: name
        });
      };
      ch.bind_global(b);
      bindings.push({ ch, b });
    }

    handles.push({ kind: 'pusher', pusher: p, app: cand.key, cluster: cand.cluster, channels: channelNames, bindings });
  }

  return { kind: 'multi-pusher', handles };
}
