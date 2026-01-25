// /var/www/scrapbot/src/sendChat.js
// Single send entrypoint used by inboundKick and elsewhere.
// IMPORTANT:
// - Kick chat must use a REAL Kick OAuth access token (bot token).
// - NEVER fall back to SCRAPBOT_EVENT_TOKEN (that is an internal Scrapbot token, not Kick OAuth).

import { sendKickChatMessage as kickChatSend } from "./lib/kickChatSend.js";
import { getBotAccessToken } from "./lib/kickBotTokens.js";

/**
 * Resolve a Kick OAuth access token.
 * Priority:
 * 1) explicit accessToken passed by caller
 * 2) SCRAPBOT_KICK_ACCESS_TOKEN (manual override)
 * 3) KICK_ACCESS_TOKEN (legacy override)
 * 4) DB-backed bot token (kick_tokens_bot id=1)
 */
async function resolveKickAccessToken(explicit) {
  const direct = String(explicit || "").trim();
  if (direct) return { token: direct, source: "explicit" };

  const envBot = String(process.env.SCRAPBOT_KICK_ACCESS_TOKEN || "").trim();
  if (envBot) return { token: envBot, source: "env:SCRAPBOT_KICK_ACCESS_TOKEN" };

  const envLegacy = String(process.env.KICK_ACCESS_TOKEN || "").trim();
  if (envLegacy) return { token: envLegacy, source: "env:KICK_ACCESS_TOKEN" };

  // DB-backed bot token (authoritative)
  const dbToken = String(await getBotAccessToken()).trim();
  if (dbToken) return { token: dbToken, source: "db:kick_tokens_bot" };

  return { token: "", source: "none" };
}

/**
 * Public API used throughout the repo.
 */
export async function sendKickChatMessage({
  channelSlug, // kept for logging / parity
  text,
  replyToMessageId = null,
  type = "bot", // default to bot
  broadcasterUserId = null,

  // optional explicit token injection
  accessToken = null,
} = {}) {
  const outText = String(text || "").trim();
  if (!outText) return { ok: false, status: 0, error: "missing_text" };

  const { token, source } = await resolveKickAccessToken(accessToken);

  console.log("[sendChat] kick token source", {
    channelSlug: channelSlug || null,
    source,
    hasToken: !!token,
    type,
    hasBroadcasterUserId: !!broadcasterUserId,
  });

  // kickChatSend will validate token/broadcaster/text again, but this makes failures obvious
  if (!token) return { ok: false, status: 0, error: "missing_kick_access_token" };

  return await kickChatSend({
    accessToken: token,
    broadcasterUserId,
    content: outText,
    type,
    replyToMessageId,
  });
}
