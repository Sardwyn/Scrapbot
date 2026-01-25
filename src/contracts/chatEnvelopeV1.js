// src/contracts/chatEnvelopeV1.js
// Canonical ChatEnvelopeV1 contract + helpers.
// Treat this as API law: all adapters must output this shape.
// Consumers should validate/normalize before use.

import crypto from "crypto";

export const CHAT_ENVELOPE_V1 = 1;

export const PLATFORM = Object.freeze({
  KICK: "kick",
  YOUTUBE: "youtube",
  TWITCH: "twitch",
});

export const INGEST = Object.freeze({
  WS: "ws",
  POLL: "poll",
  API: "api",
});

export const ROLE = Object.freeze({
  VIEWER: "viewer",
  SUBSCRIBER: "subscriber",
  MEMBER: "member",
  MOD: "mod",
  BROADCASTER: "broadcaster",
  UNKNOWN: "unknown",
});

function isIsoDateString(s) {
  // Good-enough check: Date parseable + contains T
  if (typeof s !== "string") return false;
  if (!s.includes("T")) return false;
  const t = Date.parse(s);
  return Number.isFinite(t);
}

function nonEmptyString(x) {
  return typeof x === "string" && x.trim().length > 0;
}

function toLowerSafe(x) {
  return typeof x === "string" ? x.toLowerCase() : x;
}

/**
 * Deterministic fallback ID if platform-native message id is not available.
 * NOTE: this MUST remain stable to keep dedupe/idempotency reliable.
 */
export function deriveChatIdV1({
  platform,
  channelSlug,
  authorKey,
  ts,
  text,
}) {
  const base = [
    String(platform || ""),
    String(channelSlug || ""),
    String(authorKey || ""),
    String(ts || ""),
    String(text || ""),
  ].join(":");

  return crypto.createHash("sha1").update(base).digest("hex");
}

/**
 * Normalize input into ChatEnvelopeV1.
 * - Fills defaults
 * - Sanitizes fields
 * - Ensures required invariants
 * Returns a fully-formed envelope.
 */
export function normalizeChatEnvelopeV1(input, opts = {}) {
  const nowIso = new Date().toISOString();

  const v = CHAT_ENVELOPE_V1;

  const platform = String(input?.platform || "").trim().toLowerCase();
  const scraplet_user_id = Number(input?.scraplet_user_id);

  const channelSlugRaw = input?.channel?.slug ?? input?.channel_slug ?? "";
  const channelSlug = String(channelSlugRaw).trim().toLowerCase();

  const authorDisplayRaw = input?.author?.display ?? input?.author_display ?? "";
  const authorUsernameRaw = input?.author?.username ?? input?.author_username ?? null;

  const author = {
    display: String(authorDisplayRaw || "").trim() || "Unknown",
    username: authorUsernameRaw ? String(authorUsernameRaw).trim().toLowerCase() : undefined,
    platform_user_id:
      input?.author?.platform_user_id !== undefined && input?.author?.platform_user_id !== null
        ? String(input.author.platform_user_id).trim()
        : undefined,
    role: String(input?.author?.role || ROLE.UNKNOWN).trim().toLowerCase(),
    badges: Array.isArray(input?.author?.badges) ? input.author.badges.map(String) : undefined,
  };

  // Normalize role into allowed set
  if (!Object.values(ROLE).includes(author.role)) author.role = ROLE.UNKNOWN;

  const messageTextRaw =
    input?.message?.text ?? input?.text ?? input?.message_text ?? "";
  const message = {
    text: String(messageTextRaw ?? "").toString(),
    is_action: input?.message?.is_action === true ? true : undefined,
    is_reply: input?.message?.is_reply === true ? true : undefined,
    reply_to_id:
      input?.message?.reply_to_id !== undefined && input?.message?.reply_to_id !== null
        ? String(input.message.reply_to_id).trim()
        : undefined,
  };

  const ts = nonEmptyString(input?.ts) ? String(input.ts) : nowIso;

  const source = {
    ingest: String(input?.source?.ingest || opts.ingest || "").trim().toLowerCase(),
    adapter: String(input?.source?.adapter || platform).trim().toLowerCase(),
    supervisor_id: String(input?.source?.supervisor_id || opts.supervisor_id || "").trim(),
    received_ts: nonEmptyString(input?.source?.received_ts) ? String(input.source.received_ts) : undefined,
  };

  const flags = {
    is_paid: input?.flags?.is_paid === true,
    is_command_candidate: input?.flags?.is_command_candidate === true,
  };

  // ID: prefer native id, else derive
  let id = input?.id ? String(input.id).trim() : "";
  if (!id) {
    const authorKey = author.platform_user_id || author.username || author.display;
    id = deriveChatIdV1({
      platform,
      channelSlug,
      authorKey,
      ts,
      text: message.text,
    });
  }

  const env = {
    v,
    id,
    ts,
    platform,
    scraplet_user_id,

    channel: {
      slug: channelSlug,
      platform_channel_id:
        input?.channel?.platform_channel_id !== undefined && input?.channel?.platform_channel_id !== null
          ? String(input.channel.platform_channel_id).trim()
          : undefined,
      platform_channel_name:
        input?.channel?.platform_channel_name !== undefined && input?.channel?.platform_channel_name !== null
          ? String(input.channel.platform_channel_name).trim()
          : undefined,
    },

    author,
    message,
    flags,
    source,

    platform_payload: input?.platform_payload && typeof input.platform_payload === "object"
      ? input.platform_payload
      : undefined,

    raw: input?.raw && typeof input.raw === "object" ? input.raw : undefined,
  };

  // Enforce invariants
  assertChatEnvelopeV1(env);

  return env;
}

/**
 * Throw if envelope violates ChatEnvelopeV1 invariants.
 * This should be used at the adapter boundary and optionally at major sinks.
 */
export function assertChatEnvelopeV1(env) {
  if (!env || typeof env !== "object") throw new Error("ChatEnvelopeV1: env must be an object");
  if (env.v !== CHAT_ENVELOPE_V1) throw new Error(`ChatEnvelopeV1: v must be ${CHAT_ENVELOPE_V1}`);

  if (!nonEmptyString(env.id)) throw new Error("ChatEnvelopeV1: id required");
  if (!nonEmptyString(env.ts) || !isIsoDateString(env.ts))
    throw new Error("ChatEnvelopeV1: ts must be ISO-8601");

  const platform = String(env.platform || "").trim().toLowerCase();
  if (!Object.values(PLATFORM).includes(platform))
    throw new Error(`ChatEnvelopeV1: invalid platform: ${env.platform}`);

  if (!Number.isFinite(env.scraplet_user_id) || env.scraplet_user_id <= 0)
    throw new Error("ChatEnvelopeV1: scraplet_user_id must be a positive number");

  if (!env.channel || typeof env.channel !== "object")
    throw new Error("ChatEnvelopeV1: channel required");
  if (!nonEmptyString(env.channel.slug))
    throw new Error("ChatEnvelopeV1: channel.slug required");

  if (!env.author || typeof env.author !== "object")
    throw new Error("ChatEnvelopeV1: author required");
  if (!nonEmptyString(env.author.display))
    throw new Error("ChatEnvelopeV1: author.display required");

  const role = String(env.author.role || "").trim().toLowerCase();
  if (!Object.values(ROLE).includes(role))
    throw new Error(`ChatEnvelopeV1: invalid author.role: ${env.author.role}`);

  if (!env.message || typeof env.message !== "object")
    throw new Error("ChatEnvelopeV1: message required");
  if (typeof env.message.text !== "string")
    throw new Error("ChatEnvelopeV1: message.text must be string");

  if (!env.flags || typeof env.flags !== "object")
    throw new Error("ChatEnvelopeV1: flags required");
  if (typeof env.flags.is_paid !== "boolean")
    throw new Error("ChatEnvelopeV1: flags.is_paid must be boolean");
  if (typeof env.flags.is_command_candidate !== "boolean")
    throw new Error("ChatEnvelopeV1: flags.is_command_candidate must be boolean");

  if (!env.source || typeof env.source !== "object")
    throw new Error("ChatEnvelopeV1: source required");

  const ingest = String(env.source.ingest || "").trim().toLowerCase();
  if (!Object.values(INGEST).includes(ingest))
    throw new Error(`ChatEnvelopeV1: invalid source.ingest: ${env.source.ingest}`);

  const adapter = String(env.source.adapter || "").trim().toLowerCase();
  if (!Object.values(PLATFORM).includes(adapter))
    throw new Error(`ChatEnvelopeV1: invalid source.adapter: ${env.source.adapter}`);

  if (!nonEmptyString(env.source.supervisor_id))
    throw new Error("ChatEnvelopeV1: source.supervisor_id required");
}
