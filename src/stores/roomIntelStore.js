// src/stores/roomIntelStore.js
//
// DB persistence + read access for Room Intelligence snapshots.
//
// Design goals:
// - Inserts are idempotent per (channel, bucket_ts)
// - Safe fire-and-forget inserts (engine doesn't await)
// - Timeline reads are straightforward for graphing
//

import { q } from "../lib/db.js";

function clampInt(n, min, max) {
  const x = Number.isFinite(Number(n)) ? Number(n) : 0;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function clamp01(n) {
  const x = Number.isFinite(Number(n)) ? Number(n) : 0;
  return Math.max(0, Math.min(1, x));
}

function normalizeState(s) {
  const v = String(s || "").trim();
  if (!v) return "Passive";
  return v;
}

async function insertSnapshot(snapshot) {
  // Fire-and-forget safe: never throw
  try {
    if (!snapshot) return;

    const scraplet_user_id = clampInt(snapshot.scraplet_user_id, 0, 2_000_000_000);
    const platform = String(snapshot.platform || "kick");
    const channel_slug = String(snapshot.channel_slug || "");
    const bucket_ts = snapshot.bucket_ts; // should be Date

    if (!scraplet_user_id || !platform || !channel_slug || !bucket_ts) return;

    const engagement_index = clampInt(snapshot.engagement_index, 0, 100);
    const room_state = normalizeState(snapshot.room_state);

    const r1 = clamp01(snapshot.r1);
    const r2 = clamp01(snapshot.r2);
    const r3 = clamp01(snapshot.r3);
    const r4 = clamp01(snapshot.r4);
    const r5 = clamp01(snapshot.r5);

    const messages = clampInt(snapshot.messages, 0, 1_000_000);
    const mpm = snapshot.mpm == null ? null : clampInt(snapshot.mpm, 0, 1_000_000);

    // Optional: moderation pressure read-only signal (0..100)
    const pressure = snapshot.pressure == null ? null : clampInt(snapshot.pressure, 0, 100);

    const meta = snapshot.meta || {};

    await q(
      `
      INSERT INTO public.sc_roomintel_snapshots
        (scraplet_user_id, platform, channel_slug, bucket_ts,
         engagement_index, room_state,
         r1, r2, r3, r4, r5,
         messages, mpm, pressure, meta)
      VALUES
        ($1, $2, $3, $4,
         $5, $6,
         $7, $8, $9, $10, $11,
         $12, $13, $14, $15::jsonb)
      ON CONFLICT (scraplet_user_id, platform, channel_slug, bucket_ts)
      DO UPDATE SET
        engagement_index = EXCLUDED.engagement_index,
        room_state = EXCLUDED.room_state,
        r1 = EXCLUDED.r1,
        r2 = EXCLUDED.r2,
        r3 = EXCLUDED.r3,
        r4 = EXCLUDED.r4,
        r5 = EXCLUDED.r5,
        messages = EXCLUDED.messages,
        mpm = EXCLUDED.mpm,
        pressure = EXCLUDED.pressure,
        meta = public.sc_roomintel_snapshots.meta || EXCLUDED.meta
      `,
      [
        scraplet_user_id,
        platform,
        channel_slug,
        bucket_ts,
        engagement_index,
        room_state,
        r1,
        r2,
        r3,
        r4,
        r5,
        messages,
        mpm,
        pressure,
        JSON.stringify(meta),
      ]
    );
  } catch (err) {
    console.error("[roomIntelStore] insertSnapshot failed:", err?.message || err);
  }
}

async function getTimeline({
  scraplet_user_id,
  platform = "kick",
  channel_slug,
  minutes = 30,
  limit = 2000,
}) {
  const mins = clampInt(minutes, 1, 24 * 60);
  const lim = clampInt(limit, 1, 5000);

  const { rows } = await q(
    `
    SELECT
      bucket_ts,
      engagement_index,
      room_state,
      r1, r2, r3, r4, r5,
      messages,
      mpm,
      pressure,
      meta
    FROM public.sc_roomintel_snapshots
    WHERE scraplet_user_id = $1
      AND platform = $2
      AND channel_slug = $3
      AND bucket_ts >= (now() - make_interval(mins => $4))
    ORDER BY bucket_ts ASC
    LIMIT $5
    `,
    [scraplet_user_id, platform, channel_slug, mins, lim]
  );

  return rows;
}

async function getMoments({
  scraplet_user_id,
  platform = "kick",
  channel_slug,
  minutes = 60,
  limit = 15,
}) {
  // Simple “key moments” heuristic:
  // - top EI spikes
  // - transitions (room_state changes)
  const mins = clampInt(minutes, 1, 24 * 60);
  const lim = clampInt(limit, 1, 50);

  const { rows } = await q(
    `
    WITH base AS (
      SELECT
        bucket_ts,
        engagement_index,
        room_state,
        LAG(room_state) OVER (ORDER BY bucket_ts) AS prev_state
      FROM public.sc_roomintel_snapshots
      WHERE scraplet_user_id = $1
        AND platform = $2
        AND channel_slug = $3
        AND bucket_ts >= (now() - make_interval(mins => $4))
      ORDER BY bucket_ts ASC
    ),
    spikes AS (
      SELECT bucket_ts, engagement_index, room_state, 'spike'::text AS kind
      FROM base
      ORDER BY engagement_index DESC
      LIMIT $5
    ),
    transitions AS (
      SELECT bucket_ts, engagement_index, room_state, 'transition'::text AS kind
      FROM base
      WHERE prev_state IS NOT NULL AND prev_state <> room_state
      ORDER BY bucket_ts DESC
      LIMIT $5
    )
    SELECT * FROM (
      SELECT * FROM spikes
      UNION ALL
      SELECT * FROM transitions
    ) t
    ORDER BY bucket_ts DESC
    LIMIT $5
    `,
    [scraplet_user_id, platform, channel_slug, mins, lim]
  );

  return rows;
}

export default {
  insertSnapshot,
  getTimeline,
  getMoments,
};
