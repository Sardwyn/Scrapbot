// /var/www/scrapbot/src/routes/security.js
import express from "express";
import { securityTelemetryRecent } from "../lib/securityTelemetry.js";

const router = express.Router();

router.get("/recent", (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : 200;
  return res.json(securityTelemetryRecent({ limit }));
});

export default router;
