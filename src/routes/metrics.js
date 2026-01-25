// /var/www/scrapbot/src/routes/metrics.js
import express from "express";
import { metricsSnapshot, metricsRecent } from "../lib/metrics.js";
import { securityTelemetrySnapshot } from "../lib/securityTelemetry.js";

console.log("[metricsRoutes] module loaded"); // <-- definitive proof of import execution

const router = express.Router();

function requireSecret(req, res) {
  const expected = process.env.SCRAPBOT_SHARED_SECRET;
  if (!expected) return true;

  const provided = req.headers["x-scrapbot-secret"];
  if (provided !== expected) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

router.get("/api/metrics", (req, res) => {
  console.log("[metricsRoutes] HIT /api/metrics"); // <-- definitive proof of routing match
  if (!requireSecret(req, res)) return;
  const limitChannels = Number(req.query.limitChannels || 50) || 50;
  return res.json(metricsSnapshot({ limitChannels }));
});

router.get("/api/metrics/recent", (req, res) => {
  console.log("[metricsRoutes] HIT /api/metrics/recent");
  if (!requireSecret(req, res)) return;
  const limit = Number(req.query.limit || 200) || 200;
  const order = String(req.query.order || "newest");
  return res.json(metricsRecent({ limit, order }));
});

router.get("/security", (req, res) => {
  const topN = req.query.topN ? Number(req.query.topN) : 10;
  return res.json(securityTelemetrySnapshot({ topN }));
});

export default router;
