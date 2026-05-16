// /var/www/scraplet/scrapbot/src/workers/hypeTrainOrchestrator.js
//
// Hype Train Orchestrator:
// - Polls dashboard for qualifying events (subs, tips, kicks.gifted)
// - POSTs contributions to /dashboard/api/hype-train/ingest
// - Sends Scrapbot chat narration for key moments:
//   - Train start / conductor announcement
//   - Level ups
//   - Timer warnings (10s left)
//   - Train end
// - Checks timer expiry every second

console.log('🚂 hypeTrainOrchestrator module loaded');

import { q } from '../lib/db.js';
import { sendKickChatMessage } from '../sendChat.js';

if (typeof fetch !== 'function') {
  throw new Error('[hypeTrainOrch] global fetch is not available — Node 18+ required');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function envStr(name, fallback = '') { return (process.env[name] == null ? fallback : String(process.env[name])).trim(); }
function envInt(name, fallback) { const n = Number(process.env[name]); return Number.isFinite(n) ? Math.trunc(n) : fallback; }

// ── Narration messages ─────────────────────────────────────────────────────
// Multiple variants per event — randomly selected for variety
const NARRATION = {
  start: [
    '🚂 ALL ABOARD THE {conductor} HYPE TRAIN!! CHOO CHOO!!',
    '🚂 {conductor} has started the HYPE TRAIN! Who\'s jumping on?! 🎉',
    '🚂 HYPE TRAIN DEPARTING! {conductor} is your conductor! ALL ABOARD!! 🚂💨',
  ],
  levelUp: [
    '🚂💥 LEVEL {level}!! The hype train is picking up SPEED!! Keep it going!!',
    '🔥🚂 LEVEL {level}! {conductor}\'s train is UNSTOPPABLE!! CHOO CHOO!!',
    '🚂⬆️ WE\'RE AT LEVEL {level}!! The train is going WILD!! 🎉🎉',
    '💥 LEVEL {level} HYPE TRAIN!! Someone stop this thing!! 🚂🔥',
  ],
  levelUpHigh: [
    '🔥🔥🔥 LEVEL {level}?! THIS TRAIN HAS NO BRAKES!! 🚂💨💨',
    '😱 LEVEL {level}!! THE HYPE TRAIN IS ON FIRE!! LITERALLY!! 🔥🚂🔥',
    '🚂💥 L E V E L  {level} !! Chat has LOST IT!! Keep going!!',
  ],
  warning: [
    '⚠️ 10 SECONDS! The hype train is about to leave the station! Sub or tip to keep it going!! 🚂',
    '🚨 LAST CHANCE! 10 seconds before the hype train LEAVES!! 🚂💨',
    '⏰ 10 SECONDS LEFT on the hype train!! Someone save it!! 🚂',
  ],
  end: [
    '🚂 The hype train has left the station... Thanks to everyone who rode! Peak level: {peak}! 🎉',
    '💨 Hype train ended at Level {peak}! What a ride! Thanks {conductor} for starting it! 🚂',
    '🚂 CHOO CHOO... the hype train has departed. Level {peak} reached! See you next time! 👋',
  ],
  contribution: [
    '🚂 {user} just fueled the hype train! +{pts} hype! ({points}/{total} to Level {next})!',
    '🔥 {user} is keeping the train going! {points}/{total} to Level {next}!',
  ],
};

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function format(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] !== undefined ? vars[k] : `{${k}}`);
}

// ── Dashboard API helpers ──────────────────────────────────────────────────
async function getActiveSession(dashboardUrl, token, ownerUserId) {
  try {
    const res = await fetch(`${dashboardUrl}/dashboard/api/hype-train/session?owner_user_id=${ownerUserId}`, {
      headers: { 'X-Scrapbot-Token': token, 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.session || null;
  } catch (e) {
    console.warn('[hypeTrainOrch] getActiveSession failed:', e.message);
    return null;
  }
}

async function ingestContribution(dashboardUrl, token, body) {
  try {
    const res = await fetch(`${dashboardUrl}/dashboard/api/hype-train/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Scrapbot-Token': token },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn('[hypeTrainOrch] ingestContribution failed:', e.message);
    return null;
  }
}

async function tickExpiry(dashboardUrl, token, ownerUserId) {
  try {
    const res = await fetch(`${dashboardUrl}/dashboard/api/hype-train/tick-bot`, {
      method: 'POST',
      headers: { 'X-Scrapbot-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner_user_id: ownerUserId }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function getEnabledKickAccounts() {
  const { rows } = await q(`
    SELECT owner_user_id, channel_id, broadcaster_user_id
    FROM public.scrapbot_accounts
    WHERE platform = 'kick' AND enabled = true
  `);
  return rows.map(r => ({
    owner_user_id: Number(r.owner_user_id),
    channel_slug: String(r.channel_id || '').toLowerCase(),
    broadcaster_user_id: r.broadcaster_user_id || null,
  }));
}

// Pull qualifying events from dashboard events table
async function pullHypeEvents(dashboardUrl, token, ownerUserId, since) {
  try {
    const url = new URL(`${dashboardUrl}/dashboard/api/hype-train/events`);
    url.searchParams.set('owner_user_id', String(ownerUserId));
    url.searchParams.set('since', since);
    const res = await fetch(url.toString(), {
      headers: { 'X-Scrapbot-Token': token, 'Accept': 'application/json' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.events) ? data.events : [];
  } catch (e) {
    console.warn('[hypeTrainOrch] pullHypeEvents failed:', e.message);
    return [];
  }
}

// ── Main orchestrator ──────────────────────────────────────────────────────
export function startHypeTrainOrchestrator() {
  if (envStr('HYPE_TRAIN_ORCHESTRATOR_ENABLED', '1') === '0') {
    console.log('[hypeTrainOrch] disabled via env');
    return { stop() {} };
  }

  const DASHBOARD_URL = envStr('DASHBOARD_BASE_URL', 'https://scraplet.store');
  const TOKEN = envStr('SCRAPBOT_EVENT_TOKEN');
  const POLL_MS = Math.max(500, envInt('HYPE_TRAIN_POLL_MS', 1500));
  const NARRATE = envStr('HYPE_TRAIN_NARRATE', '1') !== '0';

  if (!TOKEN) {
    console.warn('[hypeTrainOrch] SCRAPBOT_EVENT_TOKEN missing — disabled');
    return { stop() {} };
  }

  // Per-account state
  const cursors = new Map();       // owner_user_id -> ISO timestamp
  const processed = new Set();     // event IDs already handled
  const sessionState = new Map();  // owner_user_id -> { level, warned, conductorUsername, peakLevel }
  let stopped = false;

  console.log('[hypeTrainOrch] starting', { pollMs: POLL_MS, dashboardUrl: DASHBOARD_URL, narrate: NARRATE });

  async function narrate(acc, text, session) {
    // Check per-session narration toggle (falls back to env var)
    const sessionNarrate = session?.narrate !== false;
    if (!NARRATE || !sessionNarrate || !text) return;
    try {
      await sendKickChatMessage({
        channelSlug: acc.channel_slug,
        broadcasterUserId: acc.broadcaster_user_id,
        text,
        type: 'bot',
      });
    } catch (e) {
      console.warn('[hypeTrainOrch] narrate failed:', e.message);
    }
  }

  async function processAccount(acc) {
    const uid = acc.owner_user_id;

    if (!cursors.has(uid)) {
      cursors.set(uid, new Date(Date.now() - 10_000).toISOString());
    }

    // ── Check timer expiry ─────────────────────────────────────────────────
    const tickResult = await tickExpiry(DASHBOARD_URL, TOKEN, uid);
    if (tickResult?.ended) {
      const prev = sessionState.get(uid);
      if (prev) {
        // Fetch the just-ended session to check narrate flag
        const endedSession = { narrate: prev.narrate !== false };
        await narrate(acc, format(pick(NARRATION.end), {
          peak: prev.peakLevel || 1,
          conductor: prev.conductorUsername || 'someone',
        }), endedSession);
        sessionState.delete(uid);
      }
    }

    // ── Pull qualifying events ─────────────────────────────────────────────
    const since = cursors.get(uid);
    const events = await pullHypeEvents(DASHBOARD_URL, TOKEN, uid, since);

    for (const ev of events) {
      if (!ev?.id || processed.has(ev.id)) continue;
      processed.add(ev.id);

      // Update cursor
      if (ev.ts && ev.ts > cursors.get(uid)) {
        cursors.set(uid, ev.ts);
      }

      const kind = ev.kind;
      const qualifying = [
        'channel.subscription.new', 'channel.subscription.renewal',
        'channel.subscription.gifts', 'kicks.gifted', 'tip', 'donation',
      ];
      if (!qualifying.includes(kind)) continue;

      // Get active session — auto-start if widget is placed but no session exists
      let session = await getActiveSession(DASHBOARD_URL, TOKEN, uid);
      if (!session) {
        // Try to auto-start via the ingest endpoint (it handles auto-start internally)
        // Just proceed — ingest will auto-start if widget is on an overlay
        session = { narrate: true, level: 1 }; // optimistic placeholder
      }

      const prevLevel = session.level;
      const prevState = sessionState.get(uid) || { level: 1, warned: false, conductorUsername: null, peakLevel: 1, narrate: true };

      // POST contribution
      const result = await ingestContribution(DASHBOARD_URL, TOKEN, {
        user_id: uid,
        kind,
        payload: ev.payload,
        actor_username: ev.actor_username,
        actor_avatar: ev.payload?.avatar_url || null,
        platform: ev.source || 'kick',
      });

      if (!result?.ok) continue;

      const newLevel = result.level || prevLevel;
      const isConductor = !session.conductor_username && ev.actor_username;

      // Update local state — cache narrate flag from session
      const newState = {
        level: newLevel,
        warned: prevState.warned,
        conductorUsername: session.conductor_username || ev.actor_username,
        peakLevel: Math.max(prevState.peakLevel, newLevel),
        narrate: session.narrate !== false,
      };
      sessionState.set(uid, newState);

      // ── Narration ────────────────────────────────────────────────────────

      // First contribution = conductor announcement
      if (isConductor) {
        await narrate(acc, format(pick(NARRATION.start), {
          conductor: ev.actor_username,
        }), session);
        continue; // Don't also narrate the contribution
      }

      // Level up
      if (result.leveledUp) {
        const template = newLevel >= 5 ? pick(NARRATION.levelUpHigh) : pick(NARRATION.levelUp);
        await narrate(acc, format(template, {
          level: newLevel,
          conductor: newState.conductorUsername || 'the conductor',
        }), session);
        // Reset warning flag on level up
        newState.warned = false;
        sessionState.set(uid, newState);
      }
    }

    // ── Timer warning (10s left) ───────────────────────────────────────────
    const session = await getActiveSession(DASHBOARD_URL, TOKEN, uid);
    if (session?.expires_at) {
      const remaining = new Date(session.expires_at) - Date.now();
      const state = sessionState.get(uid);
      if (state && remaining > 0 && remaining <= 10_000 && !state.warned) {
        state.warned = true;
        sessionState.set(uid, state);
        await narrate(acc, pick(NARRATION.warning), session);
      }
      // Reset warning flag if timer was refreshed (more than 15s left)
      if (state && remaining > 15_000 && state.warned) {
        state.warned = false;
        sessionState.set(uid, state);
      }
    }
  }

  // ── Poll loop ──────────────────────────────────────────────────────────────
  (async function loop() {
    while (!stopped) {
      try {
        const accounts = await getEnabledKickAccounts();
        for (const acc of accounts) {
          try {
            await processAccount(acc);
          } catch (e) {
            console.warn('[hypeTrainOrch] account error:', acc.channel_slug, e.message);
          }
        }
      } catch (e) {
        console.warn('[hypeTrainOrch] loop error:', e.message);
      }
      await sleep(POLL_MS);
    }
    console.log('[hypeTrainOrch] stopped');
  })();

  return {
    stop() { stopped = true; },
  };
}
