// src/routes/roomIntelApi.js
//
// Room Intelligence API (v1.5)
// - /api/roomintel/live
// - /api/roomintel/timeline
// - /api/roomintel/moments
//
// Read-only. No automations. No moderation steering.
//

import express from "express";
import roomIntelEngine from "../intel/roomIntelEngine.js";
import roomIntelStore from "../stores/roomIntelStore.js";

const router = express.Router();

function intParam(v, def, min, max) {
  const n = Number.parseInt(String(v ?? ""), 10);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function strParam(v, def = "") {
  const s = String(v ?? "").trim();
  return s || def;
}

function requireChannelParams(req, res) {
  const scraplet_user_id = intParam(req.query.scraplet_user_id, 0, 0, 2_000_000_000);
  const platform = strParam(req.query.platform, "kick");
  const channel_slug = strParam(req.query.channel_slug, "");

  if (!scraplet_user_id || !platform || !channel_slug) {
    res.status(400).json({
      ok: false,
      error: "Missing required query params: scraplet_user_id, platform, channel_slug",
    });
    return null;
  }

  return { scraplet_user_id, platform, channel_slug };
}

// Live snapshot (in-memory)
router.get("/live", (req, res) => {
  const p = requireChannelParams(req, res);
  if (!p) return;

  const snap = roomIntelEngine.getLiveSnapshot(p);

  res.json({
    ok: true,
    live: snap,
  });
});

// Timeline (DB)
router.get("/timeline", async (req, res) => {
  const p = requireChannelParams(req, res);
  if (!p) return;

  const minutes = intParam(req.query.minutes, 30, 1, 24 * 60);
  const limit = intParam(req.query.limit, 2000, 1, 5000);

  try {
    const rows = await roomIntelStore.getTimeline({
      ...p,
      minutes,
      limit,
    });

    res.json({
      ok: true,
      minutes,
      timeline: rows,
    });
  } catch (err) {
    console.error("[roomIntelApi] /timeline failed:", err?.message || err);
    res.status(500).json({ ok: false, error: "timeline_failed" });
  }
});

// Key moments (DB)
router.get("/moments", async (req, res) => {
  const p = requireChannelParams(req, res);
  if (!p) return;

  const minutes = intParam(req.query.minutes, 60, 1, 24 * 60);
  const limit = intParam(req.query.limit, 15, 1, 50);

  try {
    const rows = await roomIntelStore.getMoments({
      ...p,
      minutes,
      limit,
    });

    res.json({
      ok: true,
      minutes,
      moments: rows,
    });
  } catch (err) {
    console.error("[roomIntelApi] /moments failed:", err?.message || err);
    res.status(500).json({ ok: false, error: "moments_failed" });
  }
});

export default router;
