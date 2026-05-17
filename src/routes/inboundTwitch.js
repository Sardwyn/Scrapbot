// routes/inboundTwitch.js
// Handles inbound Twitch events forwarded from Dashboard

import express from "express";
import { evaluateModeration } from "../moderationRuntime.js";
import { evaluateChatCommand } from "../commandRuntime.js";
import RoomIntelService from "../services/RoomIntelService.js";

const router = express.Router();

router.post("/api/inbound/twitch", async (req, res) => {
    const expectedSecret = process.env.SCRAPBOT_SHARED_SECRET;
    const providedSecret = req.headers["x-scrapbot-secret"];

    if (expectedSecret && providedSecret !== expectedSecret) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const envelope = req.body;
    if (!envelope || !envelope.platform) {
        return res.status(400).json({ ok: false, error: "invalid_envelope" });
    }

    const eventType = envelope.eventType || envelope.type || "chat.message.sent";
    const isChatEvent = eventType === "chat.message.sent" || eventType === "chat" || eventType === "message";

    if (!isChatEvent) {
        if (typeof RoomIntelService.recordTelemetry === "function") {
            try {
                RoomIntelService.recordTelemetry({
                    scraplet_user_id: Number(envelope.scraplet_user_id || envelope.scrapletUserId),
                    platform: "twitch",
                    channelSlug: (envelope.channelSlug || envelope.channel?.slug || "").toLowerCase().trim(),
                    ...(envelope.payload || envelope)
                });
            } catch (e) {
                console.warn("[inboundTwitch] recordTelemetry failed", e?.message || e);
            }
        }
        return res.json({ ok: true, ignored: true, reason: "non_chat_event", eventType });
    }

    // 1. Moderate
    const modResult = await evaluateModeration(envelope);

    if (modResult && (modResult.action === "block" || modResult.action === "ban")) {
        console.log(`[Twitch] Blocked message from ${envelope.author?.username}`);
        return res.json({ ok: true, action: "block" });
    }

    // 1.5 Room Intel
    try {
        const intelEvent = {
            platform: "twitch",
            scraplet_user_id: Number(envelope.scraplet_user_id || envelope.scrapletUserId),
            channelSlug: (envelope.channelSlug || envelope.channel?.slug || "").toLowerCase().trim(),
            userRole: envelope.author?.role || "everyone",
            text: envelope.message?.text || envelope.text || "",
            meta: {
                emoji_only: !!envelope.meta?.emoji_only,
                emote_only: !!envelope.meta?.emote_only,
            }
        };
        if (intelEvent.scraplet_user_id && intelEvent.channelSlug) {
            RoomIntelService.observe(intelEvent);
        }
    } catch (err) {
        console.warn("[Twitch] RoomIntel ingest failed", err.message);
    }

    // 2. Commands
    const cmdResult = await evaluateChatCommand(envelope);

    // Decision block for outbox worker
    return res.json({ 
      ok: true,
      decision: { action: "allow" },
      command: cmdResult ? { handled: true, result: cmdResult } : null
    });
});

export default router;
