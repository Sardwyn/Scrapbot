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
 *
 * IMPORTANT: broadcasterUserId is REQUIRED for ALL Kick sends.
 * kickChatSend requires broadcaster_user_id — there is no
 * token-bound "bot-mode" routing.  If broadcasterUserId is
 * missing the call is rejected with a warn log.
 */
export async function sendKickChatMessage({
  channelSlug, // kept for logging / parity
  text,
  replyToMessageId = null,

  // Default to "user".  Callers may pass "bot" for slash-commands.
  type = "user",

  broadcasterUserId = null,

  // optional explicit token injection
  accessToken = null,
} = {}) {
  const outText = String(text || "").trim();
  if (!outText) return { ok: false, status: 0, error: "missing_text" };

  // broadcasterUserId is mandatory — kickChatSend will reject without it.
  if (!broadcasterUserId) {
    console.warn("[sendChat] missing broadcasterUserId — cannot send", {
      channelSlug: channelSlug || null,
    });
    return { ok: false, status: 0, error: "missing_broadcaster_user_id" };
  }

  // ✅ DRY RUN ENFORCEMENT
  if (arguments[0]?.dryRun) {
    console.log("[sendChat] DRY_RUN: skipping real send", { channelSlug, text: outText });
    return { ok: true, dryRun: true, status: 200, data: "DRY_RUN_OK" };
  }

  const resolvedType = type || "user";

  const { token, source } = await resolveKickAccessToken(accessToken);

  console.log("[sendChat] kick token source", {
    channelSlug: channelSlug || null,
    source,
    hasToken: !!token,
    type: resolvedType,
    hasBroadcasterUserId: !!broadcasterUserId,
  });

  if (!token) return { ok: false, status: 0, error: "missing_kick_access_token" };

  const resp = await kickChatSend({
    accessToken: token,
    broadcasterUserId,
    content: outText,
    type: resolvedType,
    replyToMessageId,
  });

  console.log("[sendChat] kickChatSend result", {
    ok: resp?.ok,
    status: resp?.status,
    data:
      resp?.data
        ? (typeof resp.data === "string" ? resp.data.slice(0, 200) : resp.data)
        : null,
  });

  return resp;
}
