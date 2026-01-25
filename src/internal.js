// /var/www/scrapbot/src/routes/internal.js
import express from "express";
import { loadAllCommands } from "../commandStore.js";
import { sendKickChatMessage } from "../sendChat.js";
import { kickBanOrTimeout } from "../lib/kickModeration.js";

const router = express.Router();
router.use(express.json());

const INTERNAL_SECRET = process.env.SCRAPBOT_SHARED_SECRET;
if (!INTERNAL_SECRET) throw new Error("[internal] SCRAPBOT_SHARED_SECRET is not set");

// Header check
function requireInternal(req, res, next) {
  const header = req.get("x-internal-secret");
  if (!header || header !== INTERNAL_SECRET) {
    console.warn("[internal] bad or missing x-internal-secret");
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }
  next();
}

/**
 * POST /api/internal/reload-commands
 * body: { account_id? }
 */
router.post("/reload-commands", requireInternal, async (req, res) => {
  console.log("[internal] /reload-commands hit", { body: req.body });

  const { account_id } = req.body ?? {};

  try {
    await loadAllCommands();
    return res.json({
      ok: true,
      reloaded: "all",
      account_id: account_id ?? null,
    });
  } catch (err) {
    console.error("[internal] /reload-commands failed", err);
    return res.status(500).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
});

/**
 * POST /api/internal/send-chat
 * body: { broadcasterUserId, messageText, replyToMessageId?, type? }
 *
 * Used by the dashboard onboarding card to prompt: "/mod Scrapbot"
 */
router.post("/send-chat", requireInternal, async (req, res) => {
  const b = req.body || {};
  const broadcasterUserId = b.broadcasterUserId ?? b.broadcaster_user_id ?? null;
  const messageText = b.messageText ?? b.text ?? "";
  const replyToMessageId = b.replyToMessageId ?? b.reply_to_message_id ?? null;
  const type = b.type || "bot";

  if (!broadcasterUserId || !String(messageText || "").trim()) {
    return res.status(400).json({
      ok: false,
      error: "broadcasterUserId and messageText are required",
    });
  }

  try {
    const out = await sendKickChatMessage({
      broadcasterUserId,
      messageText,
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
 * We "probe" a moderation endpoint and interpret auth/permission errors.
 * - 401/403 => not modded / insufficient permissions
 * - anything else => likely modded (even if target is invalid)
 *
 * IMPORTANT: This does not rely on SCRAPBOT_LIVE_MODERATION.
 */
router.post("/verify-mod", requireInternal, async (req, res) => {
  const b = req.body || {};
  const broadcasterUserId = Number(b.broadcasterUserId ?? b.broadcaster_user_id ?? 0) || 0;
  const probeUserId = Number(b.probeUserId ?? b.probe_user_id ?? broadcasterUserId) || 0;

  if (!broadcasterUserId) {
    return res.status(400).json({
      ok: false,
      error: "broadcasterUserId is required",
    });
  }

  // We attempt a timeout probe. Even if Kick rejects self-moderation,
  // the status code will usually differ from "not modded".
  try {
    const resp = await kickBanOrTimeout({
      broadcaster_user_id: broadcasterUserId,
      user_id: probeUserId,
      duration_minutes: 1,
      reason: "scrapbot_mod_probe",
    });

    const status = resp?.status ?? 0;

    // Hard "no mod" signals
    const hasMod = !(status === 401 || status === 403);

    return res.json({
      ok: true,
      hasMod,
      status,
      // keep the payload short; dashboard can show a tiny detail string
      detail: resp?.data ? "response_data_present" : null,
    });
  } catch (err) {
    // If we threw before receiving a response, return unknown.
    console.error("[internal] /verify-mod error", err);
    return res.json({
      ok: true,
      hasMod: null,
      status: 0,
      detail: err?.message || String(err),
    });
  }
});

export default router;
