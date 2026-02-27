// /var/www/scrapbot/src/routes/internal.js
import express from "express";
import { loadAllCommands } from "../commandStore.js";
import { sendKickChatMessage } from "../sendChat.js";
import { kickBanOrTimeout } from "../lib/kickModeration.js";
import { q } from "../lib/db.js";

const router = express.Router();
router.use(express.json());

// Use the real shared secret. NO hardcoded fallback.
const INTERNAL_SECRET = process.env.SCRAPBOT_SHARED_SECRET;

if (!INTERNAL_SECRET) {
  throw new Error("[internal] SCRAPBOT_SHARED_SECRET is not set");
}

function requireInternal(req, res, next) {
  const header = req.get("x-internal-secret");
  if (!header || header !== INTERNAL_SECRET) {
    console.warn("[internal] bad or missing x-internal-secret");
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }
  next();
}

function withTimeout(promise, ms, label = "operation") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

/**
 * POST /api/internal/reload-commands
 * body: {}
 */
router.post("/reload-commands", requireInternal, async (req, res) => {
  try {
    await withTimeout(loadAllCommands(), 5000, "loadAllCommands");
    return res.json({ ok: true });
  } catch (err) {
    console.error("[internal] /reload-commands failed", err);
    const msg = err?.message || String(err);
    const status = msg.includes("timed out") ? 504 : 500;
    return res.status(status).json({ ok: false, error: msg });
  }
});

/**
 * POST /api/internal/send-chat
 * body: { broadcasterUserId, messageText, replyToMessageId?, type? }
 *
 * Dashboard onboarding helper: nudge user to "/mod Scrapbot"
 */
router.post("/send-chat", requireInternal, async (req, res) => {
  const b = req.body || {};
  const broadcasterUserId = b.broadcasterUserId ?? b.broadcaster_user_id ?? null;
  const messageText = b.messageText ?? b.text ?? "";
  const channelSlug = String(b.channelSlug ?? b.channel_slug ?? "").toLowerCase().trim() || null;
  const replyToMessageId = b.replyToMessageId ?? b.reply_to_message_id ?? null;
  const type = b.type || "user";

  if (!broadcasterUserId || !String(messageText || "").trim()) {
    return res.status(400).json({
      ok: false,
      error: "broadcasterUserId and messageText are required",
    });
  }

  try {
    const out = await sendKickChatMessage({
      broadcasterUserId,
      channelSlug,
      text: messageText,
      replyToMessageId,
      type,
    });

    return res.json({
      ok: !!out?.ok,
      status: out?.status ?? 0,
      body: out?.body ?? null,
      error: out?.error ?? null,
    });
  } catch (err) {
    console.error("[internal] /send-chat failed", err);
    return res.status(500).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
});

/**
 * POST /api/internal/verify-mod
 * body: { broadcasterUserId, probeUserId? }
 *
 * Probe moderator permission by calling a mod-required endpoint.
 * Interpretation:
 * - 401/403 => NOT modded
 * - any other status => likely modded (even if validation fails)
 */
router.post("/verify-mod", requireInternal, async (req, res) => {
  const b = req.body || {};
  const broadcasterUserId = Number(b.broadcasterUserId ?? b.broadcaster_user_id ?? 0) || 0;
  const probeUserId = Number(b.probeUserId ?? b.probe_user_id ?? broadcasterUserId) || 0;

  if (!broadcasterUserId) {
    return res.status(400).json({ ok: false, error: "broadcasterUserId is required" });
  }

  try {
    const resp = await kickBanOrTimeout({
      broadcaster_user_id: broadcasterUserId,
      user_id: probeUserId,
      duration_minutes: 1,
      reason: "scrapbot_mod_probe",
    });

    const status = resp?.status ?? 0;
    const hasMod = !(status === 401 || status === 403);

    return res.json({ ok: true, hasMod, status });
  } catch (err) {
    console.error("[internal] /verify-mod failed", err);
    return res.json({
      ok: true,
      hasMod: null,
      status: 0,
      error: err?.message || String(err),
    });
  }
});

/**
 * POST /api/internal/set-broadcaster-id
 * body: { channelSlug, broadcasterUserId }
 *
 * Dashboard backfill worker calls this after resolving a broadcaster
 * id for a channel that was missing it.
 */
router.post("/set-broadcaster-id", requireInternal, async (req, res) => {
  const b = req.body || {};
  const channelSlug = String(b.channelSlug || b.channel_slug || "").toLowerCase().trim();
  const bId = Number(b.broadcasterUserId ?? b.broadcaster_user_id ?? 0) || 0;

  if (!channelSlug || !bId) {
    return res.status(400).json({
      ok: false,
      error: "channelSlug and broadcasterUserId are required",
    });
  }

  try {
    const result = await q(
      `UPDATE public.scrapbot_accounts
       SET broadcaster_user_id = $2, updated_at = now()
       WHERE platform = 'kick' AND channel_id = $1
         AND (broadcaster_user_id IS NULL OR broadcaster_user_id != $2)`,
      [channelSlug, bId]
    );

    console.log("[internal] set-broadcaster-id", {
      channelSlug,
      broadcasterUserId: bId,
      rowCount: result?.rowCount ?? 0,
    });

    return res.json({ ok: true, updated: result?.rowCount ?? 0 });
  } catch (err) {
    console.error("[internal] /set-broadcaster-id failed", err);
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

export default router;
