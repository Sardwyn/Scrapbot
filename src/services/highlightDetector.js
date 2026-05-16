// src/services/highlightDetector.js
// Detects highlight moments from room intel flush data.
// Self-calibrating per-channel baseline (rolling 10-min window).
// Writes to public.stream_highlights via dashboard internal API.

const VPS_BASE = (process.env.VPS_BASE_URL || 'https://scraplet.store').replace(/\/$/, '');
const WORKER_SECRET = process.env.GENERATION_WORKER_SECRET || '';

// Rolling baseline per channel: last 120 buckets (10 min at 5s each)
// key = `${scraplet_user_id}|${channel_slug}`
const baselines = new Map();
const BASELINE_WINDOW = 120;
const SPIKE_THRESHOLD = 2.5;       // 2.5x baseline MPM = highlight
const ENGAGEMENT_THRESHOLD = 75;   // EI >= 75 = engagement surge
const MIN_BASELINE_SAMPLES = 12;   // need at least 1 min of data before firing
const COOLDOWN_MS = 60_000;        // don't fire same channel more than once per minute

const lastFired = new Map();

function baselineKey(scraplet_user_id, channel_slug) {
  return `${scraplet_user_id}|${channel_slug}`;
}

function updateBaseline(key, mpm) {
  const arr = baselines.get(key) || [];
  arr.push(mpm);
  if (arr.length > BASELINE_WINDOW) arr.shift();
  baselines.set(key, arr);
  return arr;
}

function rollingAvg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

async function persistHighlight(highlight) {
  try {
    const resp = await fetch(`${VPS_BASE}/api/highlights/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-worker-secret': WORKER_SECRET,
      },
      body: JSON.stringify(highlight),
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      console.warn('[highlightDetector] persist failed', resp.status, t.slice(0, 100));
    }
  } catch (e) {
    console.warn('[highlightDetector] persist error:', e.message);
  }
}

/**
 * Called from RoomIntelService on every flush.
 * snapshot = { scraplet_user_id, channel_slug, mpm, engagement_index, ... }
 */
export function checkForHighlight(snapshot) {
  const { scraplet_user_id, channel_slug, mpm, engagement_index } = snapshot;
  if (!scraplet_user_id || !channel_slug) return;

  const key = baselineKey(scraplet_user_id, channel_slug);
  const history = updateBaseline(key, mpm || 0);

  // Need enough history before we start firing
  if (history.length < MIN_BASELINE_SAMPLES) return;

  // Cooldown check
  const now = Date.now();
  if ((lastFired.get(key) || 0) + COOLDOWN_MS > now) return;

  const baseline = rollingAvg(history.slice(0, -1)); // exclude current bucket from baseline
  const currentMpm = mpm || 0;
  const ei = engagement_index || 0;

  let triggerSignal = null;
  let magnitude = 0;

  // MPM spike
  if (baseline > 2 && currentMpm >= baseline * SPIKE_THRESHOLD) {
    triggerSignal = 'mpm_spike';
    magnitude = Math.round((currentMpm / baseline) * 100) / 100;
  }
  // Engagement surge (high EI even without huge MPM spike)
  else if (ei >= ENGAGEMENT_THRESHOLD && currentMpm >= baseline * 1.5) {
    triggerSignal = 'engagement_surge';
    magnitude = Math.round((ei / 100) * 100) / 100;
  }
  // Hype burst (r5 dominant — emoji/emote flood)
  else if ((snapshot.r5 || 0) > 0.6 && currentMpm >= baseline * 1.8) {
    triggerSignal = 'hype_burst';
    magnitude = Math.round((snapshot.r5 || 0) * 100) / 100;
  }

  if (!triggerSignal) return;

  lastFired.set(key, now);

  const highlight = {
    channel_slug,
    scraplet_user_id: Number(scraplet_user_id),
    platform: snapshot.platform,
    trigger_signal: triggerSignal,
    magnitude,
    baseline_mpm: Math.round(baseline * 100) / 100,
    peak_mpm: currentMpm,
    triggered_at: new Date().toISOString(),
  };

  console.log('[highlightDetector] 🔥 highlight detected:', highlight);

  // Fire and forget — don't block the flush cycle
  persistHighlight(highlight).catch(() => {});
}
