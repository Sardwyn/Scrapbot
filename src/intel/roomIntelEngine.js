// src/intel/roomIntelEngine.js
//
// Room Intelligence Engine (v1.5)
//
// PURPOSE
// - Observe chat messages
// - Aggregate register signals over a rolling window
// - Produce time-bucketed snapshots
// - Persist snapshots via roomIntelStore
//
// HARD RULES
// - Observer only (no moderation steering)
// - Deterministic
// - In-memory first, DB on bucket rollover
//

import roomIntelStore from "../stores/roomIntelStore.js";

// -------------------------
// Configuration
// -------------------------

const BUCKET_MS = 10_000;        // 10s buckets
const WINDOW_MS = 120_000;       // 2 min rolling window
const SNAPSHOT_MIN_MESSAGES = 1; // don't emit empty buckets

// Engagement Index weights (register 1..5)
const REGISTER_WEIGHTS = {
  1: 0.5,
  2: 1.0,
  3: 1.6,
  4: 2.3,
  5: 3.0,
};

// Room state thresholds (EI 0..100)
const ROOM_STATES = [
  { max: 20, state: "Passive" },
  { max: 40, state: "Casual" },
  { max: 60, state: "Engaged" },
  { max: 80, state: "Focused" },
  { max: 100, state: "Hyped" },
];

// -------------------------
// In-memory state
// -------------------------

/**
 * channelKey -> {
 *   currentBucket: number,
 *   bucketMessages: [],
 *   windowMessages: [],
 *   lastSnapshot: object | null
 * }
 */
const channels = new Map();

// -------------------------
// Helpers
// -------------------------

function now() {
  return Date.now();
}

function bucketStart(ts) {
  return Math.floor(ts / BUCKET_MS) * BUCKET_MS;
}

function makeChannelKey({ scraplet_user_id, platform, channel_slug }) {
  return `${scraplet_user_id}:${platform}:${channel_slug}`;
}

function clamp(n, min, max) {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function registerDistribution(messages) {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const m of messages) counts[m.register]++;

  const total = messages.length || 1;
  return {
    r1: counts[1] / total,
    r2: counts[2] / total,
    r3: counts[3] / total,
    r4: counts[4] / total,
    r5: counts[5] / total,
  };
}

function engagementIndex(messages) {
  if (!messages.length) return 0;

  let weighted = 0;
  for (const m of messages) {
    weighted += REGISTER_WEIGHTS[m.register] || 0;
  }

  // Normalize against max possible weight
  const maxWeight = messages.length * REGISTER_WEIGHTS[5];
  const ei = (weighted / maxWeight) * 100;

  return clamp(Math.round(ei), 0, 100);
}

function roomState(ei) {
  for (const t of ROOM_STATES) {
    if (ei <= t.max) return t.state;
  }
  return "Hyped";
}

// -------------------------
// Core logic
// -------------------------

function flushBucket(channelKey, channel) {
  if (channel.bucketMessages.length < SNAPSHOT_MIN_MESSAGES) {
    channel.bucketMessages = [];
    return;
  }

  const snapshotTs = channel.currentBucket;
  const dist = registerDistribution(channel.bucketMessages);
  const ei = engagementIndex(channel.windowMessages);
  const state = roomState(ei);

  const snapshot = {
    scraplet_user_id: channel.meta.scraplet_user_id,
    platform: channel.meta.platform,
    channel_slug: channel.meta.channel_slug,

    bucket_ts: new Date(snapshotTs),
    engagement_index: ei,
    room_state: state,

    r1: dist.r1,
    r2: dist.r2,
    r3: dist.r3,
    r4: dist.r4,
    r5: dist.r5,

    messages: channel.bucketMessages.length,
    mpm: Math.round((channel.windowMessages.length / (WINDOW_MS / 60_000))),
  };

  channel.lastSnapshot = snapshot;
  roomIntelStore.insertSnapshot(snapshot);

  channel.bucketMessages = [];
}

function ensureChannel(meta, ts) {
  const key = makeChannelKey(meta);
  if (!channels.has(key)) {
    channels.set(key, {
      meta,
      currentBucket: bucketStart(ts),
      bucketMessages: [],
      windowMessages: [],
      lastSnapshot: null,
    });
  }
  return channels.get(key);
}

function pruneWindow(channel, ts) {
  const cutoff = ts - WINDOW_MS;
  channel.windowMessages = channel.windowMessages.filter(
    (m) => m.ts >= cutoff
  );
}

// -------------------------
// Public API
// -------------------------

function ingest({ scraplet_user_id, platform, channel_slug, register, ts }) {
  if (!register || register < 1 || register > 5) return;

  const meta = { scraplet_user_id, platform, channel_slug };
  const timestamp = ts || now();

  const channel = ensureChannel(meta, timestamp);
  const currentBucket = bucketStart(timestamp);

  // Bucket rollover
  if (currentBucket !== channel.currentBucket) {
    flushBucket(makeChannelKey(meta), channel);
    channel.currentBucket = currentBucket;
  }

  const msg = { register, ts: timestamp };

  channel.bucketMessages.push(msg);
  channel.windowMessages.push(msg);

  pruneWindow(channel, timestamp);
}

function getLiveSnapshot({ scraplet_user_id, platform, channel_slug }) {
  const key = makeChannelKey({ scraplet_user_id, platform, channel_slug });
  const channel = channels.get(key);
  if (!channel || !channel.lastSnapshot) return null;
  return channel.lastSnapshot;
}

export default {
  ingest,
  getLiveSnapshot,
};
