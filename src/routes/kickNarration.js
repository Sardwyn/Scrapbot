// /var/www/scrapbot/src/routes/kickNarration.js
// Generic narration helper: Dashboard → Scrapbot → Kick chat

import express from "express";
import { sendKickChatMessage } from "../sendChat.js";


const router = express.Router();

// Simple in-memory guards (good enough for v1)
const recentDedupe = new Map();      // dedupe_key -> ts
const recentPerChannel = new Map();  // channelKey -> ts

function nowMs() {
  return Date.now();
}

function cleanupMap(map, maxAgeMs) {
  const cutoff = nowMs() - maxAgeMs;
  for (const [k, ts] of map.entries()) {
    if (ts < cutoff) map.delete(k);
  }
}

function getClientIp(req) {
  const xff = (req.headers["x-forwarded-for"] || "").toString();
  const first = xff.split(",")[0].trim();
  return first || req.socket?.remoteAddress || "";
}

function isLocalRequest(req) {
  const ip = getClientIp(req);
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip === "localhost"
  );
}

function requireNarrationAuth(req, res, next) {
  const expected = (process.env.SCRAPBOT_NARRATION_TOKEN || "").trim();
  const provided = (req.headers["x-scraplet-secret"] || "").toString().trim();

  // If token is set, enforce it.
  if (expected) {
    if (!provided || provided !== expected) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    return next();
  }

  // If no token set, only allow localhost requests (safe default for your VPS).
  if (!isLocalRequest(req)) {
    return res.status(401).json({
      ok: false,
      error:
        "Unauthorized (set SCRAPBOT_NARRATION_TOKEN + X-Scraplet-Secret, or call from localhost)",
    });
  }

  return next();
}

/**
 * POST /api/integrations/kick/narrate
 *
 * Body:
 * {
 *   scraplet_user_id: number,
 *   channel_slug: string,
 *   broadcaster_user_id: string|number,
 *   text: string,
 *   reply_to_message_id?: string|null,
 *   dedupe_key?: string
 * }
 */
router.post("/api/integrations/kick/narrate", requireNarrationAuth, async (req, res) => {
  try {
    // Cleanup occasionally
    cleanupMap(recentDedupe, 60_000);
    cleanupMap(recentPerChannel, 10_000);

    const {
      scraplet_user_id,
      channel_slug,
      broadcaster_user_id,
      text,
      reply_to_message_id = null,
      dedupe_key = null,
    } = req.body || {};

    const msg = String(text || "").trim();
    const broadcasterUserId = broadcaster_user_id != null ? String(broadcaster_user_id) : "";
    const channelSlug = String(channel_slug || "").trim().toLowerCase();

    if (!msg || !broadcasterUserId) {
      return res.status(400).json({
        ok: false,
        error: "Missing required fields: broadcaster_user_id and text",
      });
    }

    // Rate limit: ~1 message per channel per 900ms (tweak as you like)
    const channelKey = channelSlug || `broadcaster:${broadcasterUserId}`;
    const lastTs = recentPerChannel.get(channelKey) || 0;
    if (nowMs() - lastTs < 900) {
      console.log("[narration] rate-limited", { channelKey, scraplet_user_id });
      return res.json({ ok: true, skipped: "rate-limited" });
    }
    recentPerChannel.set(channelKey, nowMs());

    // Dedupe (optional)
    const dedupeKey =
      (dedupe_key && String(dedupe_key)) || `kick:${broadcasterUserId}:${channelKey}:${msg}`;

    const lastSeen = recentDedupe.get(dedupeKey) || 0;
    if (nowMs() - lastSeen < 30_000) {
      console.log("[narration] deduped", { dedupeKey });
      return res.json({ ok: true, skipped: "deduped" });
    }
    recentDedupe.set(dedupeKey, nowMs());

    console.log("[narration] sending", {
      scraplet_user_id,
      channel_slug: channelSlug || null,
      broadcaster_user_id: broadcasterUserId,
      preview: msg.slice(0, 120),
    });

    const sendResult = await sendKickChatMessage({
      broadcasterUserId,
      messageText: msg,
      replyToMessageId: reply_to_message_id || null,
      type: "user",
    });

    if (!sendResult?.ok) {
      console.error("[narration] kick send failed", sendResult);
      return res.status(502).json({
        ok: false,
        error: "kick_send_failed",
        detail: sendResult || null,
      });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("[narration] error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Error" });
  }
});

export default router;
