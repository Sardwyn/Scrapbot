// /var/www/scrapbot/src/workers/raffleOrchestrator.js
//
// Minimal “orchestration rule” V1:
// - Watch dashboard events for raffle.winner
// - Congratulate winner in Kick chat
// - Auto reset after a short delay by emitting raffle.reset back to dashboard
//
// Node 18+ ONLY (uses global fetch)

console.log('🔥 raffleOrchestrator module loaded');

import { q } from '../lib/db.js';
import { sendKickChatMessage } from '../sendChat.js';

// -----------------------------
// HARD FAIL IF fetch IS MISSING
// -----------------------------
if (typeof fetch !== 'function') {
  throw new Error('[raffleOrch] global fetch is not available — Node 18+ required');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function envStr(name, fallback = '') {
  const v = process.env[name];
  return (v == null ? fallback : String(v)).trim();
}

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

async function getEnabledKickAccounts() {
  const { rows } = await q(`
    select
      owner_user_id,
      channel_id,
      broadcaster_user_id
    from public.scrapbot_accounts
    where platform = 'kick'
      and enabled = true
  `);

  return rows
    .map((r) => ({
      owner_user_id: Number(r.owner_user_id),
      channel_slug: String(r.channel_id || '').toLowerCase(),
      broadcaster_user_id: Number(r.broadcaster_user_id),
    }))
    .filter(
      (r) =>
        r.owner_user_id > 0 &&
        r.channel_slug &&
        Number.isFinite(r.broadcaster_user_id) &&
        r.broadcaster_user_id > 0
    );
}

async function pullWinnerEvents({ url, token, ownerUserId, sinceIso }) {
  const u = new URL(url);
  u.searchParams.set('owner_user_id', String(ownerUserId));
  u.searchParams.set('kind', 'raffle.winner');
  u.searchParams.set('since', sinceIso);

  const res = await fetch(u.toString(), {
    headers: {
      Accept: 'application/json',
      'X-Scrapbot-Token': token,
    },
  });

  if (!res.ok) {
    throw new Error(`[raffleOrch] pull failed ${res.status}`);
  }

  const json = await res.json();
  return Array.isArray(json?.events) ? json.events : [];
}

async function emitDashboardEvent({ url, body }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`[raffleOrch] ingest failed ${res.status}`);
  }
}

export function startRaffleOrchestrator() {
  if (envStr('RAFFLE_ORCHESTRATOR_ENABLED', '1') === '0') {
    console.log('[raffleOrch] disabled via env');
    return { stop() { } };
  }

  const PULL_URL =
    envStr('DASHBOARD_RAFFLE_PULL_URL') ||
    'https://scraplet.store/dashboard/api/raffle/pull';

  const INGEST_URL =
    envStr('DASHBOARD_RAFFLE_INGEST_URL') ||
    'https://scraplet.store/dashboard/api/raffle/events';

  const TOKEN = envStr('SCRAPBOT_EVENT_TOKEN');
  if (!TOKEN) {
    console.warn('[raffleOrch] SCRAPBOT_EVENT_TOKEN missing');
  }

  const pollMs = Math.max(500, envInt('RAFFLE_ORCH_POLL_MS', 1500));
  const autoResetSec = Math.max(3, envInt('RAFFLE_AUTORESET_SEC', 20));

  const ownerCursor = new Map();
  const processed = new Set();
  let stopped = false;

  console.log('[raffleOrch] starting', {
    pollMs,
    autoResetSec,
    pullUrl: PULL_URL,
    ingestUrl: INGEST_URL,
  });

  (async function loop() {
    while (!stopped) {
      try {
        const accounts = await getEnabledKickAccounts();

        for (const acc of accounts) {
          if (!ownerCursor.has(acc.owner_user_id)) {
            ownerCursor.set(
              acc.owner_user_id,
              new Date(Date.now() - 30_000).toISOString()
            );
          }

          if (!TOKEN) continue;

          const since = ownerCursor.get(acc.owner_user_id);
          const events = await pullWinnerEvents({
            url: PULL_URL,
            token: TOKEN,
            ownerUserId: acc.owner_user_id,
            sinceIso: since,
          });

          for (const ev of events) {
            if (!ev?.id || processed.has(ev.id)) continue;
            processed.add(ev.id);

            const winner = ev?.payload?.winner?.username;
            if (!winner) continue;

            console.log('[raffleOrch] winner detected', {
              channel: acc.channel_slug,
              winner,
            });

            await sendKickChatMessage({
              channelSlug: acc.channel_slug,
              broadcasterUserId: acc.broadcaster_user_id,
              type: 'bot',
              messageText: `🎉 Congrats @${winner}! You won the giveaway!`,
            });

            setTimeout(async () => {
              try {
                await emitDashboardEvent({
                  url: INGEST_URL,
                  body: {
                    user_id: acc.owner_user_id,
                    source: 'scrapbot',
                    channel_slug: acc.channel_slug,
                    kind: 'raffle.reset',
                    payload: {
                      reason: 'auto_reset',
                      caused_by_event_id: ev.id,
                    },
                  },
                });
                console.log('[raffleOrch] auto reset emitted', acc.channel_slug);
              } catch (err) {
                console.error('[raffleOrch] reset failed', err);
              }
            }, autoResetSec * 1000);
          }

          ownerCursor.set(acc.owner_user_id, new Date().toISOString());
        }
      } catch (err) {
        console.error('[raffleOrch] loop error', err);
      }

      await sleep(pollMs);
    }
  })();

  return {
    stop() {
      stopped = true;
    },
  };
}
