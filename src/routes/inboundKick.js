// /var/www/scrapbot/src/routes/inboundKick.js
//
// Inbound Kick events (forwarded from Scraplet Dashboard).
// MUST support BOTH payload styles:
//  A) New wrapper: { eventType, payload:{...} }
//  B) Legacy Kick-ish: { platform, type, message:{ raw:{ broadcaster:{channel_slug,user_id}, sender:{username,user_id,identity:{badges}}, content, message_id } } }
//
// This file keeps the newer moderation/command/swarm execution pipeline,
// but restores old normalization so commands/rules can match again.

import express from "express";
import { channelPulseTrack } from "../lib/channelPulse.js";
import { metricsRecordInbound, metricsRecordAudit } from "../lib/metrics.js";
import { tryHandleSystemCommand } from "../systemCommands.js";
import { evaluateModeration } from "../moderationRuntime.js";
import { evaluateChatCommand } from "../commandRuntime.js";
import { loadAllCommands } from "../commandStore.js";
import { loadAllModerationRules, getModerationRulesFor } from "../moderationStore.js";
import { evaluateSwarm } from "../moderation/swarmGuard.js";
import {
  decisionToActionPayload,
  executeModerationAction,
  executeSwarmActions,
} from "../moderationActions.js";

import { sendKickChatMessage } from "../sendChat.js";

// Flood guard export differs across versions; import module and probe.
import * as floodGuard from "../lib/floodGuard.js";

import { q } from "../lib/db.js";

const SCRAPBOT_STRICT_CHAT_V1 = String(process.env.SCRAPBOT_STRICT_CHAT_V1 || "false").toLowerCase() === "true"; // Default conservatively until fully deployed

// ✅ Trust system
import {
  recordSeen,
  shouldAutoHostileAction,
  recordFloodTrigger,
  recordSwarmParticipation,
} from "../stores/trustStore.js";

// ✅ Room Intelligence (observer-only)
import RoomIntelService from "../services/RoomIntelService.js";

const router = express.Router();

const DRY_RUN_ONLY = String(process.env.SCRAPBOT_DRY_RUN || "").toLowerCase() === "true";
const ENABLE_COMMAND_CHAT_REPLIES =
  String(process.env.SCRAPBOT_COMMAND_REPLIES || "true").toLowerCase() !== "false";

// --------------------------------------------
// ✅ SELF-REPLY LOOP GUARD (NO LATENCY)
// If dashboard mirrors Scrapbot's own chat back into this endpoint,
// Scrapbot must ignore its own authored messages or it will loop forever.
// --------------------------------------------
const SCRAPBOT_IGNORE_SELF =
  String(process.env.SCRAPBOT_IGNORE_SELF ?? "true").toLowerCase() === "true";

const SCRAPBOT_SELF_USERNAME = String(process.env.SCRAPBOT_SELF_USERNAME || "")
  .trim()
  .toLowerCase();

const SCRAPBOT_SELF_USER_ID = String(process.env.SCRAPBOT_SELF_USER_ID || "").trim();

function isSelfAuthored({ senderUsername, senderUserId, payload }) {
  if (!SCRAPBOT_IGNORE_SELF) return false;

  const u = String(senderUsername || "").trim().toLowerCase();
  const id = String(senderUserId || "").trim();

  // Prefer ID match if set
  if (SCRAPBOT_SELF_USER_ID && id && id === SCRAPBOT_SELF_USER_ID) return true;

  // Username match if set
  if (SCRAPBOT_SELF_USERNAME && u && u === SCRAPBOT_SELF_USERNAME) return true;

  // Extra safety: some upstreams mark bot messages explicitly
  // (cheap checks, avoids loops even if username/id not configured perfectly)
  try {
    const p = payload || {};
    const hinted =
      p?.type === "bot" ||
      p?.senderType === "bot" ||
      p?.is_bot === true ||
      p?.isBot === true ||
      p?.bot === true ||
      p?.author?.is_bot === true ||
      p?.author?.isBot === true;

    return !!hinted;
  } catch {
    return false;
  }
}

// Store priming / refresh (prevents DB reload on every inbound message)
let storesPrimed = false;
let storesPrimedAt = 0;
const STORE_REFRESH_MS = 30_000;



async function primeStoresIfNeeded() {
  const now = Date.now();
  if (!storesPrimed || now - storesPrimedAt > STORE_REFRESH_MS) {
    await Promise.allSettled([loadAllCommands(), loadAllModerationRules()]);
    storesPrimed = true;
    storesPrimedAt = now;
  }
}

function safeStr(v) {
  if (v == null) return "";
  return String(v);
}

// --------------------------------------------
// Emoji classification (prevents emoji-only hype from tripping pulse/flood/trust)
// Use RegExp constructor so older runtimes fail gracefully.
// --------------------------------------------
function isUnicodeEmojiOnly(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (/[a-z0-9]/i.test(raw)) return false;

  // IMPORTANT: use RegExp constructor so older runtimes won't hard-crash at parse time.
  try {
    const reEmoji = new RegExp("\\p{Extended_Pictographic}", "gu");
    const rePunctSym = new RegExp("[\\s\\p{P}\\p{S}]", "gu");

    const stripped = raw
      .replace(reEmoji, "")
      .replace(/[\uFE0F\u200D]/g, "")
      .replace(rePunctSym, "");

    return stripped.length === 0;
  } catch {
    return !/[a-z0-9]/i.test(raw);
  }
}

// Kick often represents channel emotes as "words" + an emotes[] array in the payload.
// If emotes[] exists and the message is made only of emote-tokens, treat as hype-only.
function isEmoteOnly(text, emotes) {
  const raw = String(text || "").trim();
  if (!raw) return false;

  // Kick emotes sometimes arrive as literal tokens in text, e.g.:
  //   [emote:1730755:emojiBubbly]
  // If the message is made ONLY of these tokens (and whitespace), treat as emote-only hype.
  const EMOTE_ONLY_RE = /^\s*(?:\[emote:\d+:[^\]]+\]\s*)+$/;
  if (EMOTE_ONLY_RE.test(raw)) return true;

  // Never classify anything link-ish as emote-only.
  if (/(https?:\/\/|www\.)\S+/i.test(raw)) return false;

  // If Kick provided an emotes[] array and the message is just emote-like tokens, treat as emote-only.
  if (!Array.isArray(emotes) || emotes.length === 0) return false;

  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;

  const isEmoteToken = (t) =>
    /^[A-Za-z0-9_]{1,48}$/.test(t) || /^:[A-Za-z0-9_]{1,48}:$/.test(t);

  if (!tokens.every(isEmoteToken)) return false;

  // Tight heuristic: if Kick told us there are emotes, and the message is basically just tokens,
  // treat as emote-only hype. Keep it tight to avoid misclassifying normal sentences.
  const maxTokens = Math.max(3, emotes.length + 2);
  return tokens.length <= maxTokens;
}

function classifyHypeOnly(text, emotes) {
  const emote_only = isEmoteOnly(text, emotes);
  const unicode_emoji_only = isUnicodeEmojiOnly(text);
  return { emoji_only: emote_only || unicode_emoji_only, emote_only };
}

// This is the canonical normalizer for ChatEnvelopeV1 payloads. (The Badboy)
function normalizeFromChatV1(chat_v1, root = {}) {
  const c = chat_v1 || {};
  const payload = root.payload || root.data || root || {};

  const scraplet_user_id =
    c.scraplet_user_id ??
    c.scrapletUserId ??
    payload.scraplet_user_id ??
    payload.scrapletUserId ??
    null;

  const channelSlugCandidate =
    c.channel?.slug ??
    c.channelSlug ??
    c.channel_slug ??
    payload.channelSlug ??
    payload.channel_slug ??
    "";

  const channelSlug = safeStr(channelSlugCandidate);

  const broadcasterUserId =
    c.channel?.platform_channel_id ??
    payload.broadcaster_user_id ??
    payload.broadcasterUserId ??
    null;

  const senderUsername = safeStr(
    c.author?.username ??
    c.author?.display ??
    payload.senderUsername ??
    payload.sender_username ??
    ""
  );

  const senderUserId =
    c.author?.platform_user_id ??
    payload.senderUserId ??
    payload.sender_user_id ??
    null;

  const text = safeStr(c.message?.text ?? "");

  const message_id = c.id ?? payload.message_id ?? payload.messageId ?? null;

  const role = safeStr(c.author?.role || "").toLowerCase();

  let badges = c.author?.badges ?? null;

  // If Kick chat_v1 gives us role but no badges, synthesize a moderator badge
  if ((!badges || (Array.isArray(badges) && badges.length === 0)) && role) {
    if (role === "mod" || role === "moderator") badges = ["moderator"];
    if (role === "broadcaster") badges = ["broadcaster"];
  }

  return {
    eventType: "chat.message.sent",
    payload,
    scraplet_user_id,
    channelSlug,
    broadcasterUserId,
    senderUsername,
    senderUserId,
    text,
    message_id,
    badges,
    meta: { from_chat_v1: true, authorRole: safeStr(c.author?.role || "").toLowerCase() },
    root,
  };
}

// Legacy Helper: normalize inbound Kick payloads into a common shape.
function normalizeInbound(root = {}) {
  const eventType = safeStr(root.eventType || root.type || root.kind || "chat.message.sent");

  // Support wrapper + legacy
  const payload = root.payload || root.data || root || {};

  // Message may be object or string depending on source
  const message = payload.message || root.message || null;

  const raw =
    (typeof message === "object" && message?.raw) || payload.message?.raw || null;

  const scraplet_user_id = payload.scraplet_user_id ?? payload.scrapletUserId ?? root.scraplet_user_id ?? null;

  // -------- CHANNEL SLUG --------
  const channelSlugCandidate =
    payload.channelSlug ||
    payload.channel_slug ||
    payload.channel?.slug ||
    root.channelSlug ||
    root.channel_slug ||
    raw?.broadcaster?.channel_slug ||
    "";

  const channelSlug = safeStr(channelSlugCandidate);

  // -------- BROADCASTER USER ID --------
  const broadcasterUserId =
    payload.broadcasterUserId ??
    payload.broadcaster_user_id ??
    root.broadcasterUserId ??
    root.broadcaster_user_id ??
    raw?.broadcaster?.user_id ??
    null;

  // -------- SENDER USERNAME --------
  const senderUsernameCandidate =
    payload.senderUsername ||
    payload.sender_username ||
    root.senderUsername ||
    root.sender_username ||
    (typeof message === "object" ? message?.sender_username : null) ||
    raw?.sender?.username ||
    payload.redeemerUsername ||
    "";

  const senderUsername = safeStr(senderUsernameCandidate);

  // -------- SENDER USER ID --------
  const senderUserId =
    payload.senderUserId ??
    payload.sender_user_id ??
    root.senderUserId ??
    root.sender_user_id ??
    (typeof message === "object" ? message?.sender_user_id : null) ??
    raw?.sender?.user_id ??
    payload.redeemerUserId ??
    null;

  // -------- MESSAGE TEXT (CRITICAL FIX) --------
  const messageTextFromMessageObject =
    typeof message === "object"
      ? (typeof message?.content === "string" ? message.content : null) ||
      (typeof message?.text === "string" ? message.text : null) ||
      (typeof message?.message === "string" ? message.message : null) ||
      null
      : null;

  const payloadMessageString = typeof payload.message === "string" ? payload.message : null;

  const rootMessageString = typeof root.message === "string" ? root.message : null;

  const textCandidate =
    (typeof payload.text === "string" ? payload.text : null) ||
    messageTextFromMessageObject ||
    payloadMessageString ||
    (typeof payload.content === "string" ? payload.content : null) ||
    (typeof root.text === "string" ? root.text : null) ||
    rootMessageString ||
    raw?.content ||
    (typeof payload.rewardTitle === "string" ? payload.rewardTitle : null) ||
    "";

  const text = safeStr(textCandidate);

  // Pull emotes/reactions arrays if the upstream sender provides them (Kick often does).
  const emotes =
    (Array.isArray(payload?.emotes) ? payload.emotes : null) ||
    (Array.isArray(root?.emotes) ? root.emotes : null) ||
    (Array.isArray(payload?.data?.emotes) ? payload.data.emotes : null) ||
    (Array.isArray(root?.data?.emotes) ? root.data.emotes : null) ||
    (Array.isArray(payload?.reactions) ? payload.reactions : null) ||
    (Array.isArray(root?.reactions) ? root.reactions : null) ||
    [];

  const { emoji_only, emote_only } = classifyHypeOnly(text, emotes);
  // -------- MESSAGE ID (reply threading needs Kick UUID, not hash) --------
  function looksLikeUuid(v) {
    const s = String(v || "").trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      s
    );
  }

  const candidateIds = [
    // Prefer canonical chat_v1 message id if present
    root?.chat_v1?.message?.id,
    payload?.chat_v1?.message?.id,

    // Dashboard legacy message wrapper
    payload?.message_id,
    payload?.messageId,
    root?.message_id,
    root?.messageId,
    typeof message === "object" ? message?.message_id : null,

    // Raw webhook payload paths (these are common)
    raw?.message?.message_id,
    raw?.message?.id,
    raw?.message_id,
  ];

  let message_id = null;
  for (const c of candidateIds) {
    const s = c == null ? "" : String(c).trim();
    if (!s) continue;
    if (looksLikeUuid(s)) {
      message_id = s;
      break;
    }
  }

  // If we didn’t find a UUID, keep a fallback id around for logging/debug,
  // but DO NOT use it for reply threading.
  if (!message_id) {
    const fallback =
      candidateIds.map((x) => (x == null ? "" : String(x).trim())).find(Boolean) ||
      null;
    message_id = fallback;
  }

  // -------- BADGES --------
  const badges =
    payload.badges ??
    payload.identity?.badges ??
    raw?.sender?.identity?.badges ??
    raw?.sender?.identity ??
    null;

  return {
    eventType,
    payload,
    scraplet_user_id,
    channelSlug,
    broadcasterUserId,
    senderUsername,
    senderUserId,
    text,
    message_id,
    badges,
    meta: { emoji_only, emote_only },
    root,
  };
}

function resolveUserRole({ payload, senderUserId, broadcasterUserId, badges, meta }) {
  // Broadcaster check
  const isBroadcaster =
    (senderUserId != null &&
      broadcasterUserId != null &&
      String(senderUserId) === String(broadcasterUserId)) ||
    payload?.isBroadcaster === true;

  // Mod check (badges can be ["moderator"] or object-ish)
  const b = badges;
  const badgeText = Array.isArray(b) ? b.map((x) => safeStr(x).toLowerCase()) : [];
  const badgeObj = b && typeof b === "object" && !Array.isArray(b) ? b : null;

  // chat_v1 events carry author.role but often have null badges
  const metaRole = safeStr(meta?.authorRole || "").toLowerCase();

  const isMod =
    payload?.isModerator === true ||
    badgeText.includes("moderator") ||
    badgeText.includes("mod") ||
    badgeObj?.moderator === true ||
    badgeObj?.mod === true ||
    metaRole === "mod" ||
    metaRole === "moderator";

  if (isBroadcaster) return "broadcaster";
  if (isMod) return "moderator";
  return "everyone";
}

async function checkFlood(event) {
  if (event && event.meta && event.meta.emoji_only === true) return null;
  // Newer module: checkFloodGuard(event, opts)
  if (typeof floodGuard.checkFloodGuard === "function") {
    return await floodGuard.checkFloodGuard(event, {});
  }
  // Legacy module: evaluateFloodGuard({ ... })
  if (typeof floodGuard.evaluateFloodGuard === "function") {
    return await floodGuard.evaluateFloodGuard({
      platform: event.platform,
      scraplet_user_id: event.scraplet_user_id,
      channelSlug: event.channelSlug,
      senderUsername: event.senderUsername,
      senderUserId: event.senderUserId,
      userRole: event.userRole,
      text: event.text,
      __tripwire: event.__tripwire || null,
    });
  }
  return null;
}

function pruneFlood() {
  if (typeof floodGuard.pruneFloodState === "function") {
    try {
      floodGuard.pruneFloodState(Date.now());
    } catch { }
  }
}

// Best-effort: classify whether a swarm action is "hot signature" (severe offender).
// Keep conservative: only return true if we see strong hints.
function isHotSignatureAction(action = {}) {
  const reason = safeStr(action.reason || action.note || action.label).toLowerCase();

  // Explicit flags if present
  if (action.hot_signature === true) return true;
  if (action.is_hot_signature === true) return true;
  if (action.signature_hot === true) return true;

  // If the action metadata carries it
  if (action.meta?.hot_signature === true) return true;
  if (action.meta?.hotSignature === true) return true;

  // Heuristics: only match strong phrases
  if (reason.includes("hot_signature")) return true;
  if (reason.includes("global_watchlist")) return true;
  if (reason.includes("ban_on_sight")) return true;

  // If the action carries a signature id + explicitly severe action
  const hasSig = action.signature_id || action.signatureId || action.signature;
  const act = safeStr(action.action).toLowerCase();
  if (hasSig && (act === "ban" || act === "timeout")) {
    if (reason.includes("signature")) return true;
  }

  return false;
}

router.post("/api/inbound/kick", async (req, res) => {
  const expected = process.env.SCRAPBOT_SHARED_SECRET;

  // DEBUG: verify ChatEnvelopeV1 arrives from Dashboard
  if (req.body?.chat_v1) {
    const c = req.body.chat_v1;
    console.log("[inboundKick] chat_v1 received", {
      v: c.v,
      platform: c.platform,
      channel: c.channel?.slug,
      author: c.author?.username,
      authorKeys: c.author && typeof c.author === "object" ? Object.keys(c.author) : null,
      badges: c.author?.badges ?? null,
      identityBadges: c.author?.identity?.badges ?? null,
      identity: c.author?.identity ?? null,
      senderId: c.author?.platform_user_id ?? c.author?.id ?? null,
      text: c.message?.text?.slice(0, 120),
    });
  }

  if (expected) {
    const provided = req.headers["x-scrapbot-secret"];
    if (provided !== expected) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
  }

  let event = null;
  let pulse = null;
  let tripwire = null;
  let floodDecision = null;
  let swarmDecision = null;
  let moderationDecision = null;
  let commandDecision = null;
  let commandReplySent = false;

  // DEBUG: verify if Kick emotes/reactions are present in the inbound payload
  try {
    const b = req.body || {};
    const msg = b.message || b.data || b.payload || b; // defensive: depends how dashboard forwards
    console.log(
      "[inboundKick][debug] topKeys=",
      Object.keys(b),
      "msgKeys=",
      msg && typeof msg === "object" ? Object.keys(msg) : typeof msg
    );
    console.log(
      "[inboundKick][debug] text=",
      JSON.stringify(msg?.text ?? msg?.message ?? msg?.content ?? b?.text ?? b?.message ?? ""),
      "emotes=",
      Array.isArray(msg?.emotes)
        ? msg.emotes.length
        : Array.isArray(b?.emotes)
          ? b.emotes.length
          : null,
      "reactions=",
      Array.isArray(msg?.reactions)
        ? msg.reactions.length
        : Array.isArray(b?.reactions)
          ? b.reactions.length
          : null
    );
  } catch (e) {
    console.log("[inboundKick][debug] log failed", e?.message || e);
  }

  try {
    const body = req.body || {};

    // Phase 3: Strict chat_v1 enforcement
    if (SCRAPBOT_STRICT_CHAT_V1) {
      const chat_v1 = body?.chat_v1;
      if (!chat_v1 || typeof chat_v1 !== "object") {
        const clientIp = req.ip || req.headers["x-forwarded-for"] || "unknown";
        console.error(
          "[inboundKick] STRICT MODE: rejected request without chat_v1",
          { clientIp, hasChatV1: !!chat_v1 }
        );
        return res.status(400).json({
          ok: false,
          error: "chat_v1_required",
          message: "SCRAPBOT_STRICT_CHAT_V1 mode enabled: chat_v1 field is required",
        });
      }

      if (!chat_v1.platform || !chat_v1.scraplet_user_id || !chat_v1.message) {
        return res.status(400).json({
          ok: false,
          error: "invalid_chat_v1",
          message: "chat_v1 missing required fields",
        });
      }
    }

    // Phase 4: Validated Idempotency / Dedupe
    if (body.chat_v1) {
      const c1 = body.chat_v1;
      const eventId = c1.event_id;

      // SCRAPBOT_STRICT_CHAT_V1 implies event_id is MUST
      if (SCRAPBOT_STRICT_CHAT_V1 && !eventId) {
        return res.status(400).json({
          ok: false,
          error: "event_id_required",
          message: "Strict mode requires chat_v1.event_id"
        });
      }

      if (eventId) {
        try {
          const { rowCount } = await q(`
              INSERT INTO public.processed_events (event_id, platform, channel_slug, message_id)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (event_id) DO NOTHING
          `, [
            eventId,
            c1.platform || 'kick',
            c1.channel?.slug || null,
            c1.message?.id || null
          ]);

          if (rowCount === 0) {
            console.log(`[inboundKick] DUPLICATE event ignored: ${eventId}`);
            return res.json({ ok: true, deduped: true });
          }
        } catch (dbErr) {
          console.error("[inboundKick] Dedupe check failed", dbErr);
          // Fail closed to prevent double side-effects
          return res.status(500).json({ ok: false, error: "dedupe_check_failed" });
        }
      }
    }

    const inbound = body.chat_v1
      ? normalizeFromChatV1(body.chat_v1, body)
      : normalizeInbound(body);

    if (body?.chat_v1) {
      console.log("[kick][roleProbe]", {
        channel: inbound?.channelSlug,
        user: inbound?.senderUsername,
        senderUserId: inbound?.senderUserId,
        author_role: body.chat_v1?.author?.role ?? null,
        badges: inbound?.badges ?? null,
      });
    }

    // ✅ SELF LOOP GUARD — must happen AFTER normalization so we catch both payload styles
    if (isSelfAuthored({
      senderUsername: inbound?.senderUsername,
      senderUserId: inbound?.senderUserId,
      payload: inbound?.payload
    })) {
      console.log("[inboundKick] ignoring self-authored message", {
        senderUsername: inbound?.senderUsername,
        senderUserId: inbound?.senderUserId,
        channelSlug: inbound?.channelSlug,
        message_id: inbound?.message_id || null,
      });
      return res.status(200).json({ ok: true, ignored: true, reason: "self_message" });
    }

    // DEBUG: show normalized inbound too
    try {
      console.log("[inboundKick][debug] normalized keys=", Object.keys(inbound || {}));
      console.log(
        "[inboundKick][debug] normalized text=",
        JSON.stringify(inbound?.text || ""),
        "rootKeys=",
        inbound?.root && typeof inbound.root === "object"
          ? Object.keys(inbound.root)
          : typeof inbound.root,
        "payloadKeys=",
        inbound?.payload && typeof inbound.payload === "object"
          ? Object.keys(inbound.payload)
          : typeof inbound.payload
      );

      // Look for emote-ish arrays in normalized root/payload
      const p = inbound?.payload || {};
      const r = inbound?.root || {};
      console.log(
        "[inboundKick][debug] normalized emote candidates=",
        "payload.emotes=",
        Array.isArray(p?.emotes) ? p.emotes.length : null,
        "payload.reactions=",
        Array.isArray(p?.reactions) ? p.reactions.length : null,
        "root.emotes=",
        Array.isArray(r?.emotes) ? r.emotes.length : null,
        "root.reactions=",
        Array.isArray(r?.reactions) ? r.reactions.length : null
      );
    } catch (e) {
      console.log("[inboundKick][debug] normalized log failed", e?.message || e);
    }

    const {
      eventType,
      payload,
      scraplet_user_id,
      channelSlug,
      broadcasterUserId,
      senderUsername,
      senderUserId,
      text,
      message_id,
      badges,
      meta,
      root,
    } = inbound;

    const isChatEvent =
      eventType === "chat.message.sent" ||
      eventType === "chat" ||
      eventType === "chat_message" ||
      eventType === "message";

    if (!isChatEvent) {
      return res
        .status(200)
        .json({ ok: true, ignored: true, reason: "non_chat_event", eventType });
    }

    if (!scraplet_user_id || !channelSlug) {
      return res.status(400).json({
        ok: false,
        error: "missing scraplet_user_id or channelSlug",
        got: { scraplet_user_id, channelSlug },
      });
    }

    await primeStoresIfNeeded();

    const userRole = resolveUserRole({ payload, senderUserId, broadcasterUserId, badges, meta });

    const results = [];

    event = {
      platform: "kick",
      scraplet_user_id: Number(scraplet_user_id),
      channelSlug: channelSlug.toLowerCase().trim(),
      broadcasterUserId,
      senderUsername,
      senderUserId,
      userRole,
      text: text || "",
      message_id,
      raw: root,
      payload,
      meta: meta || null,
      __tripwire: null,
    };

    // --------------------------------------------
    // SYSTEM COMMANDS (e.g. !tts)
    // --------------------------------------------
    try {
      const handled = await tryHandleSystemCommand(event);
      if (handled) {
        metricsRecordInbound({
          platform: event.platform,
          channelSlug: event.channelSlug,
          scraplet_user_id: event.scraplet_user_id,
          userRole: event.userRole,
          senderUsername: event.senderUsername,
          senderUserId: event.senderUserId,
          eventType,
          message_id: event.message_id,
          pulse,
          tripwire,
          floodDecision: null,
          swarmDecision: null,
          moderationDecision: null,
          commandDecision: "system:tts",
          commandReplySent: false,
          error: null,
        });

        return res.status(200).json({ ok: true, systemCommand: true });
      }
    } catch (e) {
      console.error("[systemCommand] failed", e?.message || e);
    }

    // --------------------------------------------
    // Channel pulse tracking (tripwire input)
    // --------------------------------------------

    // Guard: emoji-only hype should not affect pulse/tripwire
    if (event.meta && event.meta.emoji_only === true) {
      pulse = null;
    } else {
      pulse = channelPulseTrack({
        platform: "kick",
        channelSlug: event.channelSlug,
        scraplet_user_id: event.scraplet_user_id,
        senderUserId: event.senderUserId,
        senderUsername: event.senderUsername,
      });
    }

    // whatever your pulse returns, we store it for guards
    tripwire = pulse?.tripwire || pulse?.trip || pulse?.state || null;
    event.__tripwire = tripwire;

    // RoomIntel observer (write point)
    RoomIntelService.observe(event);

    // --------------------------------------------
    // Trust: record "seen" + early hostile precheck
    // --------------------------------------------
    const isPrivileged = event.userRole === "broadcaster" || event.userRole === "mod";
    if (!isPrivileged && event.senderUserId != null) {
      try {
        await recordSeen({
          platform: "kick",
          channel_id: event.channelSlug,
          user_id: String(event.senderUserId),
          emoji_only: !!event?.meta?.emoji_only,
        });
      } catch (e) {
        console.warn("[trust] recordSeen failed", e?.message || e);
      }

      // ✅ This is where ban-on-sight belongs: BEFORE any other guards/actions.
      // `shouldAutoHostileAction` should internally consider global+channel trust, ban_on_sight, etc.
      try {
        // Guard: emoji-only messages should never trigger hostile-floor actions

        if (event.meta && event.meta.emoji_only === true) {
          throw Object.assign(new Error("emoji_only_skip_hostile"), { __skip_hostile: true });
        }

        const hostile = await shouldAutoHostileAction({
          platform: "kick",
          channel_id: event.channelSlug,
          user_id: String(event.senderUserId),
        });

        if (hostile?.ok && hostile?.hostile) {
          const action = safeStr(hostile.action || "").toLowerCase();
          const duration_seconds = Number(hostile.duration_seconds || 0) || 0;
          const reason = safeStr(hostile.reason || "trust_auto_hostile");

          if (DRY_RUN_ONLY) {
            results.push({
              dryRun: true,
              label: "trust_hostile",
              decision: { action, duration_seconds, reason, trust: hostile.trust || null },
            });
          } else {
            const r = await executeModerationAction({
              platform: "kick",
              broadcasterUserId,
              channelSlug: event.channelSlug,
              targetUserId: event.senderUserId ?? null,
              targetUsername: event.senderUsername ?? null,
              action: action === "ban" ? "ban" : "timeout",
              duration_seconds: action === "ban" ? 0 : duration_seconds,
              reason,
              message_id: event.message_id,
              delete_message: true,
            });
            results.push({ label: "trust_hostile", result: r });
          }

          // Even if we acted, we still report metrics and exit early.
          metricsRecordInbound({
            platform: event.platform,
            channelSlug: event.channelSlug,
            scraplet_user_id: event.scraplet_user_id,
            userRole: event.userRole,
            senderUsername: event.senderUsername,
            senderUserId: event.senderUserId,
            eventType,
            message_id: event.message_id,
            pulse,
            tripwire,
            floodDecision,
            swarmDecision,
            moderationDecision,
            commandDecision,
            commandReplySent,
            error: null,
          });

          return res.status(200).json({
            ok: true,
            hostile: true,
            pulse,
            tripwire,
            results,
          });
        }
      } catch (e) {
        if (e && e.__skip_hostile) {
          // Intentional skip for emoji/emote-only hype
          console.log("[trust] skipped hostile-floor (emoji/emote-only)");
        } else {
          console.warn("[trust] shouldAutoHostileAction failed", e?.message || e);
        }
      }
    }

    // --------------------------------------------
    // Rules + Guards
    // --------------------------------------------
    const rules = getModerationRulesFor({
      platform: "kick",
      scraplet_user_id: event.scraplet_user_id,
      channelSlug: event.channelSlug,
    });

    const skipGuards = event.userRole === "broadcaster" || event.userRole === "mod";

    // flood
    pruneFlood();
    floodDecision = skipGuards ? { matched: false } : await checkFlood(event);

    // --------------------------------------------
    // FLOODGUARD ACTIONS
    // --------------------------------------------
    if (floodDecision?.matched) {
      // floodGuard returns action + duration_seconds
      // Safer default: treat "ban" from floodguard as a timeout unless you *really* want auto-bans
      const floodAction =
        String(floodDecision.action || "timeout").toLowerCase() === "ban"
          ? "timeout"
          : String(floodDecision.action || "timeout").toLowerCase();

      if (DRY_RUN_ONLY) {
        results.push({
          dryRun: true,
          label: "flood",
          decision: {
            action: floodAction,
            duration_seconds: floodDecision.duration_seconds || 0,
            meta: floodDecision.meta || null,
          },
        });
      } else {
        const r = await executeModerationAction({
          platform: "kick",
          broadcasterUserId,
          channelSlug: event.channelSlug,
          targetUserId: event.senderUserId ?? null,
          targetUsername: event.senderUsername ?? null,
          action: floodAction,
          duration_seconds: floodDecision.duration_seconds || 0,
          reason: "flood_guard",
          message_id: event.message_id,
          delete_message: true,
        });
        results.push({ label: "flood", result: r });

        // Trust: only record if live action actually executed (avoid poisoning trust on dry run / skipped)
        try {
          if (r?.ok && !r?.skipped && event.senderUserId != null) {
            await recordFloodTrigger({
              platform: "kick",
              channel_id: event.channelSlug,
              user_id: String(event.senderUserId),
              reason: "flood_guard",
            });
          }
        } catch (e) {
          console.warn("[trust] recordFloodTrigger failed", e?.message || e);
        }

        // Visibility
        console.log(
          "[GUARD] flood",
          JSON.stringify({
            channel: event.channelSlug,
            user: event.senderUsername,
            userId: event.senderUserId,
            action: floodAction,
            duration_seconds: floodDecision.duration_seconds || 0,
            ok: r?.ok,
            skipped: r?.skipped,
            error: r?.error || null,
            steps: r?.steps || [],
          })
        );
      }
    }

    // SwarmGuard
    swarmDecision = skipGuards ? { matched: false, actions: [] } : await evaluateSwarm(event);

    // Moderation rules (phrase match, etc.)
    moderationDecision = await evaluateModeration({
      platform: "kick",
      scraplet_user_id: event.scraplet_user_id,
      channelSlug: event.channelSlug,
      text: event.text,
      senderUsername: event.senderUsername,
      userRole: event.userRole,
      meta: {
        senderUserId: event.senderUserId,
        broadcasterUserId: event.broadcasterUserId,
        message_id: event.message_id,
        floodDecision,
        swarmDecision,
        rulesCount: rules.length,
        pulse,
        tripwire,
      },
    });

    // Commands
    commandDecision = await evaluateChatCommand({
      platform: "kick",
      channelSlug: event.channelSlug,
      userName: event.senderUsername,
      userRole: event.userRole,
      messageText: event.text,
    });

    // --------------------------------------------
    // SWARM ACTIONS + TRUST RECORDING
    // --------------------------------------------
    if (swarmDecision?.matched && Array.isArray(swarmDecision.actions) && swarmDecision.actions.length) {
      if (DRY_RUN_ONLY) {
        results.push({ dryRun: true, label: "swarm", actions: swarmDecision.actions });
      } else {
        const r = await executeSwarmActions({
          platform: "kick",
          broadcasterUserId,
          channelSlug: event.channelSlug,
          message_id: event.message_id,
          actions: swarmDecision.actions,
        });
        results.push({ label: "swarm", result: r });

        // Trust: record sender participation + targets AFTER execution
        try {
          const didAct = !!r?.ok && !r?.skipped;

          if (didAct) {
            if (event.senderUserId != null) {
              await recordSwarmParticipation({
                platform: "kick",
                channel_id: event.channelSlug,
                user_id: String(event.senderUserId),
                reason: "swarm_participation",
                hot_signature: false,
              });
            }

            for (const a of swarmDecision.actions) {
              const targetId =
                a?.targetUserId ?? a?.target_user_id ?? a?.userId ?? a?.user_id ?? null;
              if (targetId == null) continue;

              await recordSwarmParticipation({
                platform: "kick",
                channel_id: event.channelSlug,
                user_id: String(targetId),
                reason: safeStr(a?.reason || a?.note || "swarm_action"),
                hot_signature: isHotSignatureAction(a),
              });
            }
          }
        } catch (e) {
          console.warn("[trust] recordSwarmParticipation failed", e?.message || e);
        }
      }
    }

    // --------------------------------------------
    // MODERATION ACTION
    // --------------------------------------------
    if (moderationDecision?.matched) {
      const actionPayload = decisionToActionPayload({ decision: moderationDecision, event });

      if (DRY_RUN_ONLY) {
        results.push({ dryRun: true, label: "moderation", actionPayload });
      } else if (actionPayload) {
        const r = await executeModerationAction({
          platform: "kick",
          broadcasterUserId,
          channelSlug: event.channelSlug,
          targetUserId: moderationDecision?.targetUserId ?? event.senderUserId ?? null,
          targetUsername: moderationDecision?.targetUsername ?? event.senderUsername ?? null,
          action: actionPayload.action,
          duration_seconds: actionPayload.duration_seconds,
          reason: actionPayload.reason,
          message_id: event.message_id,
          delete_message: actionPayload.delete_message !== false,
        });
        results.push({ label: "moderation", result: r });
      }
    }

    // --------------------------------------------
    // COMMAND REPLY (optional)
    // --------------------------------------------
    // Forensics note:
    // We only send a chat reply if we can extract a non-empty response text from commandDecision.
    // If a command is matched but produces no response text, we log the decision shape once
    // (so we can align the contract without guessing).
    function extractReplyText(decision) {
      if (!decision) return null;

      // Common cases
      if (typeof decision === "string") return decision;

      // Likely shapes from various runtimes
      const candidates = [
        decision.text,
        decision.response?.text,
        decision.responseText,
        decision.replyText,
        decision.reply_text,
        decision.message,
        decision.out,
        decision.output,
        decision.say,
        decision.narration?.text,
        decision.result?.text,
        decision.payload?.text,
      ];

      for (const c of candidates) {
        if (typeof c === "string" && c.trim()) return c;
      }

      // Array-of-lines case
      if (Array.isArray(decision.lines)) {
        const joined = decision.lines
          .map((x) => (x == null ? "" : String(x)))
          .join("\n")
          .trim();
        if (joined) return joined;
      }

      // Generic fallback: try first string field
      if (typeof decision === "object") {
        for (const [k, v] of Object.entries(decision)) {
          if (typeof v === "string" && v.trim()) return v;
          if (v && typeof v === "object") {
            const inner = v.text ?? v.message ?? v.output ?? null;
            if (typeof inner === "string" && inner.trim()) return inner;
          }
        }
      }

      return null;
    }

    const replyText = extractReplyText(commandDecision);

    // If we matched a command but couldn't derive reply text, log the shape (forensic).
    // (Keeps noise low: only logs when there's clearly a match candidate.)
    if (ENABLE_COMMAND_CHAT_REPLIES && !replyText) {
      try {
        const matchedHint =
          commandDecision?.matched === true ||
          commandDecision?.ok === true ||
          commandDecision?.command != null ||
          commandDecision?.id != null ||
          commandDecision?.name != null ||
          commandDecision?.trigger_pattern != null;

        if (matchedHint) {
          console.warn("[inboundKick][commands] matched but no reply text extracted", {
            keys:
              commandDecision && typeof commandDecision === "object"
                ? Object.keys(commandDecision).slice(0, 40)
                : null,
            decision: commandDecision,
          });
        }
      } catch (_) { }
    }

    if (ENABLE_COMMAND_CHAT_REPLIES && replyText && safeStr(replyText).trim()) {
      const out = safeStr(replyText).trim();

      if (DRY_RUN_ONLY) {
        results.push({ dryRun: true, label: "command_reply", text: out });
        commandReplySent = true;
      } else {
        // Only attach reply threading if the inbound event has a real Kick message id.
        // (kickChatSend will also validate; this just makes intent explicit.)
        const replyTo = event.message_id || null;

        //TEMP: forensics log to verify we have the right context to send a reply (channelSlug, broadcasterUserId, scraplet_user_id)

        console.log('[commands] send reply', {
          channelSlug: event.channelSlug,
          broadcasterUserId: event.broadcasterUserId,
          senderUsername: event.senderUsername,
          message_id: event.message_id,
        });

        const r = await sendKickChatMessage({
          channelSlug: event.channelSlug,
          text: out,
          replyToMessageId: replyTo,
          type: "user",
          broadcasterUserId: event.broadcasterUserId ? Number(event.broadcasterUserId) : null,
        });
        results.push({ label: "command_reply", result: r });
        commandReplySent = !!r?.ok;
      }
    }

    // ---- metrics + ring buffer (in-memory)
    metricsRecordInbound({
      platform: event.platform,
      channelSlug: event.channelSlug,
      scraplet_user_id: event.scraplet_user_id,
      userRole: event.userRole,
      senderUsername: event.senderUsername,
      senderUserId: event.senderUserId,
      eventType,
      message_id: event.message_id,
      pulse,
      tripwire,
      floodDecision,
      swarmDecision,
      moderationDecision,
      commandDecision,
      commandReplySent,
      error: null,
    });

    // ---- audit ring (detailed decision log)
    metricsRecordAudit({
      event_id: body?.chat_v1?.event_id || null,
      message_id: event.message_id,
      channelSlug: event.channelSlug,
      senderUsername: event.senderUsername,
      senderUserId: event.senderUserId,
      userRole: event.userRole,
      text_preview: event.text,
      floodDecision,
      swarmDecision,
      moderationDecision,
      commandDecision,
      trustDecision: null,
      actions_attempted: results.filter(r => r.label).map(r => r.label),
      actions_results: results,
    });

    return res.status(200).json({
      ok: true,
      matched: !!moderationDecision?.matched,
      moderationDecision: moderationDecision || null,
      commandDecision: commandDecision || null,
      floodDecision,
      swarmDecision: swarmDecision || null,
      pulse,
      tripwire,
      results,
      debug: {
        rulesLoadedForUser: rules.length,
        normalized: {
          channelSlug: event.channelSlug,
          senderUsername: event.senderUsername,
          text: event.text,
          message_id: event.message_id,
        },
      },
    });
  } catch (err) {
    console.error("[inboundKick] error:", {
      msg: String(err?.message || err),
      stack: String(err?.stack || ""),
      channelSlug: event?.channelSlug || inbound?.channelSlug || null,
      senderUsername: event?.senderUsername || inbound?.senderUsername || null,
      senderUserId: event?.senderUserId || inbound?.senderUserId || null,
      scraplet_user_id: event?.scraplet_user_id || inbound?.scraplet_user_id || null,
    });

    // Record failure (best-effort)
    try {
      metricsRecordInbound({
        platform: event?.platform || "kick",
        channelSlug: event?.channelSlug || "",
        scraplet_user_id: event?.scraplet_user_id || null,
        userRole: event?.userRole || null,
        senderUsername: event?.senderUsername || null,
        senderUserId: event?.senderUserId || null,
        eventType: "chat.message.sent",
        message_id: event?.message_id || null,
        pulse,
        tripwire,
        floodDecision,
        swarmDecision,
        moderationDecision,
        commandDecision,
        commandReplySent,
        error: String(err?.message || err),
      });
    } catch { }

    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

export default router;