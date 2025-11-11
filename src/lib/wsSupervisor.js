import { q } from './db.js';
import { connectChannel } from './chatConnect.js';
import { forwardEvent } from './forward.js';
import { buildEvent } from './envelope.js';

const sessions = new Map();

function summarize(x, n = 300) {
  try { const s = typeof x === 'string' ? x : JSON.stringify(x); return s.length > n ? s.slice(0,n)+'…' : s; }
  catch { return String(x).slice(0,n); }
}

function normalizePusherEvent(eventName, msg) {
  const e = String(eventName || '').toLowerCase();

  if (e.includes('chatmessage')) {
    const user = msg?.sender ?? msg?.user ?? msg?.author ?? {};
    const text = msg?.message ?? msg?.content ?? msg?.text ?? msg?.body ?? null;
    const username = user?.username ?? user?.name ?? null;
    const userId = user?.id ?? user?.user_id ?? null;

    if (text && username) {
      return {
        type: 'chat.message',
        data: { user: { id: userId ? String(userId) : '', username: String(username) }, text: String(text) },
        message_id: msg?.id
      };
    }
  }
  return { type: 'chat.event', data: { event: eventName, raw: msg } };
}

export async function ensureChannelConnected(slug) {
  const key = String(slug).toLowerCase();
  if (sessions.has(key)) return;

  async function start() {
    try {
      const handle = await connectChannel(key, {
        onEvent: async ({ source, slug, chatroomId, event, msg }) => {
          let kind = 'chat.event';
          let payload = {};
          if (source === 'pusher') {
            const norm = normalizePusherEvent(event, msg);
            kind = norm.type;
            payload = norm.data || {};
            if (norm.message_id) payload.message_id = norm.message_id;
          } else {
            kind = 'chat.event';
            payload = { raw: msg };
          }

          const env = buildEvent({
            kind,
            channel: { slug, chatroom_id: chatroomId },
            actor: payload.user || { id: '', username: '' },
            data: { ...payload },
            raw: msg
          });

          console.log(`[chat:${source}] ${slug} (${chatroomId}) ${kind}`, summarize(payload));
          forwardEvent(kind, env).catch(()=>{});
        }
      });

      sessions.set(key, { handle, reconnectTimer: null });
      console.log('[chat] connected', key, handle?.kind || 'unknown');
    } catch (e) {
      console.error('[chat] failed to connect', key, e?.message || e);
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    const entry = sessions.get(key);
    if (entry?.reconnectTimer) return;
    const timer = setTimeout(() => {
      sessions.delete(key);
      ensureChannelConnected(key).catch(() => {});
    }, 5000);
    if (entry) entry.reconnectTimer = timer;
    else sessions.set(key, { handle: null, reconnectTimer: timer });
  }

  await start();
}

export async function connectAllKnownChannels() {
  const { rows } = await q(`select channel_slug from channels`);
  for (const r of rows) await ensureChannelConnected(r.channel_slug);
}

export async function disconnectChannel(slug) {
  const key = String(slug).toLowerCase();
  const entry = sessions.get(key);
  if (!entry) return false;
  try {
    if (entry.handle?.ws) entry.handle.ws.close();
    if (entry.handle?.pusher) entry.handle.pusher.disconnect();
  } catch {}
  if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
  sessions.delete(key);
  console.log('[chat] disconnected', key);
  return true;
}
