import { evaluateChatCommand } from '../commandRuntime.js';
import { sendKickChatMessage } from '../sendChat.js';
import { q } from './db.js';
import { connectChannel } from './chatConnect.js';
import { forwardEvent } from './forward.js';
import { buildEvent } from './envelope.js';
import { refreshIfNeeded } from './refreshKick.js';
import { probeKickModerator } from "./probeKickModerator.js";


const sessions = new Map();

// Cache broadcaster_user_id by channel slug (kick channel_id string)
const broadcasterIdCache = new Map();

async function getBroadcasterUserIdForSlug(slug) {
  const key = String(slug || "").toLowerCase().trim();
  if (!key) return null;

  if (broadcasterIdCache.has(key)) {
    return broadcasterIdCache.get(key);
  }

  const { rows } = await q(
    `
    select broadcaster_user_id
    from public.scrapbot_accounts
    where platform='kick'
      and channel_id=$1
      and enabled=true
    order by id asc
    limit 1
    `,
    [key]
  );

  const id = rows?.[0]?.broadcaster_user_id ? Number(rows[0].broadcaster_user_id) : null;
  broadcasterIdCache.set(key, Number.isFinite(id) && id > 0 ? id : null);
  return broadcasterIdCache.get(key);
}


function summarize(x, n = 300) {
  try {
    const s = typeof x === 'string' ? x : JSON.stringify(x);
    return s.length > n ? s.slice(0, n) + '…' : s;
  } catch {
    return String(x).slice(0, n);
  }
}

function safeStr(v) {
  if (v == null) return null;
  return String(v);
}

function extractUser(u = {}) {
  return {
    id: u.id ?? null,
    username: safeStr(u.username),
    is_anonymous: !!u.is_anonymous,
    is_verified: !!u.is_verified,
    color: u.identity?.username_color ?? null,
    badges: Array.isArray(u.identity?.badges)
      ? u.identity.badges.map(b => ({
          text: safeStr(b.text),
          type: safeStr(b.type)
        }))
      : []
  };
}

function extractBadgeFlags(badges = []) {
  const flags = {
    is_broadcaster: false,
    is_mod: false,
    is_vip: false,
    is_founder: false,
    is_subscriber: false
  };

  for (const b of badges) {
    const t = (b.type || '').toLowerCase();
    if (t === 'broadcaster') flags.is_broadcaster = true;
    if (t === 'moderator') flags.is_mod = true;
    if (t === 'vip') flags.is_vip = true;
    if (t === 'founder') flags.is_founder = true;
    if (t === 'subscriber') flags.is_subscriber = true;
  }

  return flags;
}

async function autoProbeModStatusForSlug(slug) {
  try {
    const channelId = String(slug || "").toLowerCase().trim();
    if (!channelId) return;

    const { rows } = await q(
      `
      select platform, channel_id, broadcaster_user_id
      from public.scrapbot_accounts
      where platform='kick'
        and channel_id=$1
        and enabled=true
      limit 1
      `,
      [channelId]
    );

    const acct = rows[0];
    const broadcasterUserId = acct?.broadcaster_user_id ? Number(acct.broadcaster_user_id) : null;

    // If we don't know broadcaster_user_id yet, we can't probe.
    if (!Number.isFinite(broadcasterUserId) || broadcasterUserId <= 0) {
      console.log("[modProbe] skipped (missing broadcaster_user_id)", { channelId });
      return;
    }

    const probe = await probeKickModerator({
      channelSlug: channelId,
      broadcasterUserId
    });

    // Persist into scrapbot_channel_status (same table your /api/status/channels reads)
    await q(
      `
      insert into public.scrapbot_channel_status
        (platform, channel_id, mod_status, mod_http_code, mod_checked_at, updated_at)
      values
        ('kick', $1, $2, $3, now(), now())
      on conflict (platform, channel_id)
      do update set
        mod_status = excluded.mod_status,
        mod_http_code = excluded.mod_http_code,
        mod_checked_at = excluded.mod_checked_at,
        updated_at = now()
      `,
      [channelId, probe.mod_status, probe.http_code ?? null]
    );

    console.log("[modProbe] result", { channelId, ...probe });
  } catch (err) {
    console.error("[modProbe] error", slug, err?.message || err);
  }
}


/**
 * Normalize Kick Pusher events into a stable internal shape.
 */
function normalizePusherEvent(eventName, msg) {
  const e = (eventName || '').toLowerCase();

  // Chat message
  if (e.includes('messageevent')) {
    const m = msg.message || msg; // some payloads nest under .message
    const sender = extractUser(m.sender);
    const identity = m.sender?.identity || {};
    const badges = identity.badges || [];
    const flags = extractBadgeFlags(badges);

    const channel = msg.channel || msg.chatroom?.channel || {};
    const chatroom = msg.chatroom || channel.chatroom || {};

    return {
      type: 'chat.message',
      data: {
        message_id: m.id ?? null,
        chatroom_id: m.chatroom_id ?? chatroom.id ?? null,
        channel_id: channel.id ?? null,
        channel_slug: channel.slug ?? null,
        user: sender,
        text: m.content ?? null,
        emotes: m.emotes ?? [],
        is_broadcaster: flags.is_broadcaster,
        is_mod: flags.is_mod,
        is_vip: flags.is_vip,
        is_founder: flags.is_founder,
        is_subscriber: flags.is_subscriber,
        created_at: m.created_at ?? null
      }
    };
  }

  // Stream online
  if (e.includes('streamerislive')) {
    const ls = msg.livestream || {};
    const channel = ls.channel || msg.channel || {};
    const chatroom = msg.chatroom || channel.chatroom || {};

    return {
      type: 'system.stream.online',
      data: {
        channel_id: ls.channel_id ?? channel.id ?? null,
        channel_slug: channel.slug ?? null,
        chatroom_id: chatroom.id ?? null,
        livestream_id: ls.id ?? null,
        session_title: ls.session_title ?? null,
        started_at: ls.created_at ?? ls.started_at ?? null
      }
    };
  }

  // Stream offline
  if (e.includes('stopstreambroadcast')) {
    const channel = msg.channel || {};
    const chatroom = msg.chatroom || channel.chatroom || {};

    return {
      type: 'system.stream.offline',
      data: {
        channel_id: channel.id ?? null,
        channel_slug: channel.slug ?? null,
        chatroom_id: chatroom.id ?? null,
        ended_at: msg.ended_at ?? msg.timestamp ?? null
      }
    };
  }

  // Host / raid
  if (e.includes('hostingevent')) {
    const hosted = msg.hosted_channel || {};
    const channel = hosted.channel || {};
    const fromChannel = msg.channel || {};
    const chatroom = msg.chatroom || channel.chatroom || {};

    return {
      type: 'chat.raid',
      data: {
        from_channel_id: fromChannel.id ?? null,
        from_channel_slug: fromChannel.slug ?? null,
        to_channel_id: channel.id ?? null,
        to_channel_slug: channel.slug ?? null,
        to_username: hosted.username ?? null,
        viewers: msg.number_viewers ?? hosted.viewers_count ?? null,
        message: msg.optional_message ?? null
      }
    };
  }

  // Moderation events
  if (e.includes('userbannedevent')) {
    const user = extractUser(msg.user);
    const mod = extractUser(msg.banned_by);
    const reason = msg.reason ?? null;
    const duration = msg.duration ?? null;

    const channel = msg.channel || {};
    const chatroom = msg.chatroom || channel.chatroom || {};

    return {
      type: 'chat.mod.ban',
      data: {
        user,
        moderator: mod,
        reason,
        duration,
        channel_id: channel.id ?? null,
        channel_slug: channel.slug ?? null,
        chatroom_id: chatroom.id ?? null
      }
    };
  }

  if (e.includes('userunbannedevent')) {
    const user = extractUser(msg.user);
    const mod = extractUser(msg.unbanned_by);

    const channel = msg.channel || {};
    const chatroom = msg.chatroom || channel.chatroom || {};

    return {
      type: 'chat.mod.unban',
      data: {
        user,
        moderator: mod,
        channel_id: channel.id ?? null,
        channel_slug: channel.slug ?? null,
        chatroom_id: chatroom.id ?? null
      }
    };
  }

  if (e.includes('userupdatedevent')) {
    const user = extractUser(msg.user);
    const mod = extractUser(msg.updated_by || msg.moderator || {});
    const channel = msg.channel || {};
    const chatroom = msg.chatroom || channel.chatroom || {};

    return {
      type: 'chat.mod.user_update',
      data: {
        user,
        moderator: mod,
        channel_id: channel.id ?? null,
        channel_slug: channel.slug ?? null,
        chatroom_id: chatroom.id ?? null,
        payload: msg
      }
    };
  }

  // Subscriptions / gifts
  if (e.includes('subscriptionevent')) {
    const user = extractUser(msg.user);
    const channel = msg.channel || {};
    const chatroom = msg.chatroom || channel.chatroom || {};

    return {
      type: 'chat.subscription',
      data: {
        user,
        months: msg.months ?? null,
        is_gift: false,
        tier: msg.tier ?? null,
        channel_id: channel.id ?? null,
        channel_slug: channel.slug ?? null,
        chatroom_id: chatroom.id ?? null
      }
    };
  }

  if (e.includes('giftedsubscriptionsevent')) {
    const usernames = msg.gifted_usernames ?? msg.usernames ?? [];
    const gifter = msg.gifter_username ?? msg.user?.username ?? null;

    const channel = msg.channel || msg.chatroom?.channel || {};
    const chatroom = msg.chatroom || channel.chatroom || {};

    return {
      type: 'chat.subscription.gift_batch',
      data: {
        gifter_username: safeStr(gifter),
        usernames: Array.isArray(usernames) ? usernames.map(u => safeStr(u)) : [],
        count: Array.isArray(usernames) ? usernames.length : 0,
        channel_id: channel.id ?? null,
        channel_slug: channel.slug ?? null,
        chatroom_id: chatroom.id ?? null
      }
    };
  }

  // Tips / donations
  if (e.includes('tipsevent')) {
    const user = extractUser(msg.user);
    const channel = msg.channel || {};
    const chatroom = msg.chatroom || channel.chatroom || {};

    return {
      type: 'chat.tip',
      data: {
        user,
        amount: msg.amount ?? null,
        currency: msg.currency ?? null,
        message: msg.message ?? null,
        channel_id: channel.id ?? null,
        channel_slug: channel.slug ?? null,
        chatroom_id: chatroom.id ?? null
      }
    };
  }

  // Follows
  if (e.includes('followevent')) {
    const user = extractUser(msg.user);
    const channel = msg.channel || {};
    const chatroom = msg.chatroom || channel.chatroom || {};

    return {
      type: 'chat.follow',
      data: {
        user,
        channel_id: channel.id ?? null,
        channel_slug: channel.slug ?? null,
        chatroom_id: chatroom.id ?? null
      }
    };
  }

  // Polls
  if (e.includes('pollupdateevent')) {
    const p = msg.poll || {};
    return {
      type: 'chat.poll.update',
      data: {
        title: p.title ?? null,
        options: Array.isArray(p.options)
          ? p.options.map(opt => ({
              id: opt.id,
              label: opt.label,
              votes: opt.votes
            }))
          : [],
        duration: p.duration ?? null
      }
    };
  }

  // Slowmode / room mode changes
  if (e.includes('roomupdateevent')) {
    const rm = msg.room_mode || {};
    const slow = rm.slow_mode || {};
    const fol = rm.followers_mode || {};
    const em = rm.emotes_mode || {};
    const abp = rm.advanced_bot_protection || {};

    const channel = msg.channel || {};
    const chatroom = msg.chatroom || channel.chatroom || {};

    return {
      type: 'chat.room.update',
      data: {
        channel_id: channel.id ?? null,
        channel_slug: channel.slug ?? null,
        chatroom_id: chatroom.id ?? null,
        slow_mode: {
          enabled: !!slow.enabled,
          wait_time: slow.wait_time ?? null
        },
        followers_mode: {
          enabled: !!fol.enabled,
          min_duration: fol.min_duration ?? null
        },
        emotes_mode: {
          enabled: !!em.enabled
        },
        advanced_bot_protection: {
          enabled: !!abp.enabled,
          remaining_time: abp.remaining_time ?? null
        }
      }
    };
  }

  if (e.includes('pinnedmessagecreatedevent')) {
    const m = msg.message || {};
    const sender = extractUser(m.sender);
    const identity = m.sender?.identity || {};
    const badges = identity.badges || [];
    const flags = extractBadgeFlags(badges);

    return {
      type: 'chat.pin.created',
      data: {
        chatroom_id: m.chatroom_id ?? null,
        message_id: m.id ?? null,
        content: m.content ?? null,
        duration: msg.duration ?? null,
        user: sender,
        is_broadcaster: flags.is_broadcaster,
        is_mod: flags.is_mod,
        is_vip: flags.is_vip,
        is_founder: flags.is_founder,
        is_subscriber: flags.is_subscriber
      }
    };
  }

  if (e.includes('pinnedmessagedeletedevent')) {
    const m = msg.message || {};
    const channel = msg.channel || {};
    const chatroom = msg.chatroom || channel.chatroom || {};

    return {
      type: 'chat.pin.deleted',
      data: {
        chatroom_id: m.chatroom_id ?? chatroom.id ?? null,
        message_id: m.id ?? null
      }
    };
  }

  // Fallback
  return {
    type: 'chat.event',
    data: {
      event_name: eventName,
      payload: msg
    }
  };
}

// ---------------------------------------------------------------------------
// CONNECTION MANAGEMENT
// ---------------------------------------------------------------------------

/**
 * Internal: establish a channel session.
 * If options.force=true, we tear down any existing session and reconnect.
 */
async function _ensureChannelConnected(slug, options = {}) {
  const key = String(slug).toLowerCase();
  if (!key) return;

  if (!options.force && sessions.has(key)) return;

  if (options.force && sessions.has(key)) {
    await disconnectChannel(key);
  }

  async function start() {
    try {
      try {
        await refreshIfNeeded(key);
      } catch {}

      const handle = await connectChannel(key, {
        onEvent: async ({ source, slug, chatroomId, event, msg }) => {
          let kind = 'chat.event';
          let payload = {};

          if (source === 'pusher') {
            const norm = normalizePusherEvent(event, msg);
            kind = norm.type;
            payload = norm.data || {};

            // 🔍 LIVE DEBUG: see when Kick says "live/offline"
            if (kind === 'system.stream.online' || kind === 'system.stream.offline') {
              console.log(
                '[live-debug] normalized live event from Kick',
                'slug=',
                slug,
                'event=',
                event,
                'kind=',
                kind,
                'chatroomId=',
                chatroomId,
                'payload=',
                summarize(payload)
              );
            }

            // ────────────────────────────────────────────────
            //  COMMAND PIPELINE: detect, log, evaluate, respond
            // ────────────────────────────────────────────────
            if (kind === 'chat.message') {
              console.log(
                '[commands] incoming chat message',
                'slug=', slug,
                'user=', payload.user?.username,
                'text=', payload.text
              );

              const user = payload.user || { username: '' };

              let userRole = 'everyone';
              if (payload.is_broadcaster) userRole = 'broadcaster';
              else if (payload.is_mod) userRole = 'mod';

              try {
                const cmdResult = await evaluateChatCommand({
                  platform: 'kick',
                  channelSlug: slug,
                  userName: user.username || '',
                  userRole,
                  messageText: payload.text || ''
                });

                if (cmdResult && cmdResult.type === 'text') {
                  const broadcasterUserId = await getBroadcasterUserIdForSlug(slug);

                  if (!broadcasterUserId) {
                    console.warn("[commands] cannot reply: missing broadcaster_user_id for slug=", slug);
                  } else {
                    await sendKickChatMessage({
                      channelSlug: slug,
                      broadcasterUserId,
                      text: cmdResult.text,
                      // optionally reply to the triggering message if you want:
                      // replyToMessageId: payload.message_id ?? null,
                      // type: "bot" // your kickChatSend coerces to "user" if broadcasterUserId is present
                    });
                  }

                }
              } catch (err) {
                console.error('[commands] error evaluating command for', slug, err);
              }
            }
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

          console.log(
            `[chat:${source}] ${slug} (${chatroomId}) ${kind}`,
            summarize(payload)
          );

          forwardEvent(kind, env).catch(() => {});
        }
      });

      sessions.set(key, { handle, reconnectTimer: null });
      console.log('[chat] connected', key, handle?.kind || 'unknown');
      // Kick mod probe: updates scrapbot_channel_status so dashboard can show “connected”
      autoProbeModStatusForSlug(key).catch(() => {});

    } catch (e) {
      console.error('[chat] failed to connect', key, e?.message || e);
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    const entry = sessions.get(key);
    if (entry?.reconnectTimer) return;

    const timer = setTimeout(async () => {
      sessions.delete(key);
      try {
        await refreshIfNeeded(key);
      } catch {}
      _ensureChannelConnected(key).catch(() => {});
    }, 5000);

    if (entry) entry.reconnectTimer = timer;
    else sessions.set(key, { handle: null, reconnectTimer: timer });
  }

  await start();
}

export async function ensureChannelConnected(slug) {
  return _ensureChannelConnected(slug, { force: false });
}

/**
 * CLEAN BREAK:
 * scrapbot_accounts is the single source of truth for which channels we watch.
 *
 * This function reconciles current sessions with enabled rows:
 * - connects enabled channels that aren't connected
 * - disconnects sessions for channels that are no longer enabled
 */
export async function connectAllKnownChannels() {
  const { rows } = await q(`
    select channel_id
    from public.scrapbot_accounts
    where platform='kick' and enabled=true
    order by id asc
  `);

  const shouldBeConnected = new Set(
    rows
      .map(r => String(r?.channel_id || '').trim().toLowerCase())
      .filter(Boolean)
  );

  // Connect missing
  for (const slug of shouldBeConnected) {
    await _ensureChannelConnected(slug, { force: false });
  }

  // Disconnect stale
  for (const slug of sessions.keys()) {
    if (!shouldBeConnected.has(slug)) {
      await disconnectChannel(slug);
    }
  }
}

// Watching = "do we currently have a live session handle for this channel?"
export function isWatchingChannel(slugOrKey) {
  const raw = String(slugOrKey || "").trim().toLowerCase();
  if (!raw) return false;

  // Support both storage keys:
  // - "scraplet"
  // - "kick:scraplet"
  // - any "<platform>:<slug>"
  const candidates = new Set([raw]);

  if (!raw.includes(":")) {
    candidates.add(`kick:${raw}`); // default platform
  } else {
    // also allow just the slug part
    const parts = raw.split(":");
    if (parts.length === 2 && parts[1]) candidates.add(parts[1]);
  }

  for (const k of candidates) {
    const entry = sessions.get(k);
    if (entry?.handle) return true;
  }
  return false;
}


// Backwards-compat: let other modules import connectChannel from wsSupervisor.
// Under the hood this runs ensureChannelConnected(), which boots the session.
export { ensureChannelConnected as connectChannel };

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
