// src/workers/raffleManager.js
// In-memory raffle state manager per channel.
// Handles !join, !raffle start/roll/stop with subscriber weighting.

import { q } from '../lib/db.js';

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://scraplet.store';
const SCRAPBOT_TOKEN = process.env.SCRAPBOT_EVENT_TOKEN || '';

// Per-channel raffle state
// channelSlug -> { status, entrants: Map<username, count>, config, ownerUserId, animation }
const raffles = new Map();

function getRaffle(channelSlug) {
  return raffles.get(channelSlug) || null;
}

function createRaffle(channelSlug, ownerUserId, config) {
  const raffle = {
    status: 'collecting',   // collecting | rolling | winner | idle
    entrants: new Map(),    // username -> entry count
    config: {
      joinCommand: config.joinCommand || '!join',
      subWeight:   Math.max(1, Number(config.subWeight) || 1),
      animation:   config.animation || 'wheel',
    },
    ownerUserId,
    channelSlug,
    startedAt: Date.now(),
  };
  raffles.set(channelSlug, raffle);
  return raffle;
}

function clearRaffle(channelSlug) {
  raffles.delete(channelSlug);
}

// Get raffle config from dashboard
async function fetchRaffleConfig(ownerUserId) {
  try {
    const url = `${DASHBOARD_URL}/dashboard/api/raffle/config?owner_user_id=${ownerUserId}`;
    const res = await fetch(url, {
      headers: { 'X-Scrapbot-Token': SCRAPBOT_TOKEN, Accept: 'application/json' },
    });
    if (!res.ok) return { subWeight: 1, joinCommand: '!join' };
    return await res.json();
  } catch {
    return { subWeight: 1, joinCommand: '!join' };
  }
}

// Emit event to dashboard
async function emitEvent(ownerUserId, channelSlug, kind, payload) {
  try {
    await fetch(`${DASHBOARD_URL}/dashboard/api/raffle/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Scrapbot-Token': SCRAPBOT_TOKEN,
      },
      body: JSON.stringify({ user_id: ownerUserId, source: 'scrapbot', channel_slug: channelSlug, kind, payload }),
    });
  } catch (err) {
    console.error('[raffleManager] emitEvent failed:', err.message);
  }
}

// Check if a user is a subscriber in this channel
async function isSubscriber(channelSlug, username) {
  try {
    const { rows } = await q(
      `SELECT 1 FROM public.chat_messages
       WHERE channel_slug = $1 AND actor_username = $2
         AND payload->>'type' IN ('channel.subscription.new','channel.subscription.renewal')
       LIMIT 1`,
      [channelSlug, username]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

// Build sampleNames array from entrants (weighted)
function buildPool(raffle) {
  const pool = [];
  for (const [username, count] of raffle.entrants) {
    for (let i = 0; i < count; i++) pool.push(username);
  }
  return pool;
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function startRaffle(channelSlug, ownerUserId, animationOverride) {
  const existing = getRaffle(channelSlug);
  if (existing && existing.status === 'collecting') {
    return { ok: false, message: 'Raffle already collecting entries.' };
  }

  const config = await fetchRaffleConfig(ownerUserId);
  if (animationOverride) config.animation = animationOverride;

  const raffle = createRaffle(channelSlug, ownerUserId, config);

  await emitEvent(ownerUserId, channelSlug, 'raffle.state', {
    status: 'collecting',
    count: 0,
    joinPhrase: config.joinCommand,
    animation: config.animation,
    sampleNames: [],
    sessionId: `${channelSlug}:${Date.now()}`,
  });

  console.log(`[raffleManager] started for ${channelSlug}, joinCmd=${config.joinCommand}, subWeight=${config.subWeight}`);
  return { ok: true, message: `Raffle started! Type ${config.joinCommand} to enter.` };
}

export async function handleJoin(channelSlug, username, badges) {
  const raffle = getRaffle(channelSlug);
  if (!raffle || raffle.status !== 'collecting') return { ok: false };

  if (raffle.entrants.has(username)) {
    return { ok: false, message: `@${username} you're already in!` };
  }

  // Determine entry count based on subscriber status
  let entryCount = 1;
  if (raffle.config.subWeight > 1) {
    // Check badges first (fast), then DB
    const isSub = (badges && badges.some(b => b.type === 'subscriber')) ||
                  await isSubscriber(channelSlug, username);
    if (isSub) entryCount = raffle.config.subWeight;
  }

  raffle.entrants.set(username, entryCount);

  const count = raffle.entrants.size;
  const pool = buildPool(raffle);

  // Emit updated state every 5 joins to avoid flooding
  if (count % 5 === 0 || count <= 5) {
    await emitEvent(raffle.ownerUserId, channelSlug, 'raffle.state', {
      status: 'collecting',
      count,
      joinPhrase: raffle.config.joinCommand,
      animation: raffle.config.animation,
      sampleNames: pool.slice(0, 120),
      sessionId: `${channelSlug}:${raffle.startedAt}`,
    });
  }

  const subNote = entryCount > 1 ? ` (${entryCount}x sub bonus!)` : '';
  return { ok: true, message: `@${username} entered!${subNote} (${count} total)` };
}

export async function rollRaffle(channelSlug, animationOverride) {
  const raffle = getRaffle(channelSlug);
  if (!raffle) return { ok: false, message: 'No active raffle.' };
  if (raffle.entrants.size === 0) return { ok: false, message: 'No entries yet.' };

  raffle.status = 'rolling';
  const pool = buildPool(raffle);
  const anim = animationOverride || raffle.config.animation;

  await emitEvent(raffle.ownerUserId, channelSlug, 'raffle.state', {
    status: 'rolling',
    count: raffle.entrants.size,
    joinPhrase: raffle.config.joinCommand,
    animation: anim,
    sampleNames: pool.slice(0, 120),
    sessionId: `${channelSlug}:${raffle.startedAt}`,
  });

  // Pick winner (weighted pool)
  const winner = pool[Math.floor(Math.random() * pool.length)];
  raffle.status = 'winner';
  raffle.winner = winner;

  // Short delay for animation
  setTimeout(async () => {
    await emitEvent(raffle.ownerUserId, channelSlug, 'raffle.winner', {
      winner: { username: winner, platform: 'kick' },
      pool: pool.slice(0, 120),
      animation: anim,
      sessionId: `${channelSlug}:${raffle.startedAt}`,
    });
    console.log(`[raffleManager] winner: ${winner} in ${channelSlug}`);
  }, 2000);

  return { ok: true, winner, message: `Rolling... 🎲` };
}

export async function stopRaffle(channelSlug) {
  const raffle = getRaffle(channelSlug);
  if (!raffle) return { ok: false, message: 'No active raffle.' };

  await emitEvent(raffle.ownerUserId, channelSlug, 'raffle.reset', {
    reason: 'manual_stop',
  });

  clearRaffle(channelSlug);
  return { ok: true, message: 'Raffle stopped.' };
}

export function getRaffleStatus(channelSlug) {
  return getRaffle(channelSlug);
}

export function isJoinCommand(text, channelSlug) {
  const raffle = getRaffle(channelSlug);
  if (!raffle || raffle.status !== 'collecting') return false;
  const cmd = raffle.config.joinCommand.toLowerCase().trim();
  return text.trim().toLowerCase() === cmd || text.trim().toLowerCase().startsWith(cmd + ' ');
}
