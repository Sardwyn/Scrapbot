// /var/www/scrapbot/src/lib/kickChatSend.js
// Kick chat sender — Node 18+ global fetch, no node-fetch dependency.

const DEBUG_REPLIES =
  String(process.env.SCRAPBOT_DEBUG_REPLIES || "").toLowerCase() === "true";

function looksLikeKickReplyUuid(v) {
  const s = String(v || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function sanitizeReplyToMessageId(raw) {
  if (raw == null) return null;

  let s = String(raw).trim();
  if (!s) return null;

  // Only UUIDs are replyable for Kick reply_to_message_id
  if (!looksLikeKickReplyUuid(s)) return null;

  return s;
}

async function postChat({ token, body }) {
  const resp = await fetch("https://api.kick.com/public/v1/chat", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const raw = await resp.text().catch(() => "");
  return { ok: resp.ok, status: resp.status, body: raw };
}

/**
 * Canonical sender implementation.
 */
export async function kickChatSend({
  accessToken,
  broadcasterUserId,
  content,
  type = "user",
  replyToMessageId = null,
}) {
  const token = String(accessToken || "").trim();
  const bIdRaw = String(broadcasterUserId || "").trim();
  const text = String(content || "").trim();

  if (!token) return { ok: false, status: 0, error: "missing_access_token" };
  if (!bIdRaw) return { ok: false, status: 0, error: "missing_broadcaster_user_id" };
  if (!text) return { ok: false, status: 0, error: "missing_content" };

  if (typeof fetch !== "function") {
    return { ok: false, status: 0, error: "global_fetch_missing (need Node 18+)" };
  }

  const replyId = sanitizeReplyToMessageId(replyToMessageId);

  if (replyToMessageId && !replyId && DEBUG_REPLIES) {
    console.warn("[kickChatSend] ignoring invalid replyToMessageId", { raw: replyToMessageId });
  }

  const broadcaster_user_id = Number.isFinite(Number(bIdRaw)) ? Number(bIdRaw) : bIdRaw;

  const baseBody = {
    type: String(type || "user"),
    broadcaster_user_id,
    content: text,
  };

  const bodyWithReply = replyId
    ? { ...baseBody, reply_to_message_id: replyId }
    : baseBody;

  try {
    // Attempt #1 (with reply threading if available)
    const r1 = await postChat({ token, body: bodyWithReply });

    if (DEBUG_REPLIES) {
      console.log("[kickChatSend] response", {
        status: r1.status,
        ok: r1.ok,
        triedReply: !!replyId,
      });
    }

    // If Kick rejects the reply target (commonly 404), retry without reply threading.
    if (!r1.ok && r1.status === 404 && replyId) {
      if (DEBUG_REPLIES) {
        console.warn("[kickChatSend] reply_to_message_id rejected (404). Retrying without reply.", {
          reply_to_message_id: replyId,
        });
      }

      const r2 = await postChat({ token, body: baseBody });

      if (DEBUG_REPLIES) {
        console.log("[kickChatSend] retry response", { status: r2.status, ok: r2.ok });
      }

      // Return retry result, but keep the original failure visible for forensics.
      return {
        ...r2,
        meta: {
          retry_without_reply: true,
          first_status: r1.status,
          first_body: r1.body,
        },
      };
    }

    return r1;
  } catch (err) {
    return { ok: false, status: 0, error: err?.message || String(err) };
  }
}

/**
 * Compatibility export used by adapters.
 */
export async function sendKickChatMessage(args) {
  return kickChatSend(args);
}
