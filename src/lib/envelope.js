// /src/lib/envelope.js
import { randomUUID } from "crypto";

/**
 * Canonical, platform-agnostic envelope.
 * This is the ONLY format we send cross-service (Scrapbot -> Dashboard).
 *
 * Notes:
 * - `platform` is the external platform ("kick", "twitch", ...).
 * - `type` is the normalized event type (recommended long-term).
 * - `kind` is allowed for compatibility (legacy provider kind).
 */
export function createEnvelope({
  platform,
  type,
  kind = null,
  owner_user_id = null,

  channel = {},
  actor = {},

  payload = {},
  raw = null,

  source = "scrapbot",
  meta = {},
} = {}) {
  return {
    v: 1,
    id: "env_" + randomUUID(),
    ts: new Date().toISOString(),

    source,
    platform: platform ? String(platform) : null,

    // normalized type (preferred) + legacy kind (optional)
    type: type ? String(type) : null,
    kind: kind ? String(kind) : null,

    owner_user_id: owner_user_id ?? null,

    channel: {
      slug: channel?.slug ? String(channel.slug) : null,
      chatroom_id: channel?.chatroom_id ?? null,
      channel_id: channel?.channel_id ?? null,
    },

    actor: {
      id: actor?.id != null ? String(actor.id) : null,
      username: actor?.username != null ? String(actor.username) : null,
    },

    payload: payload || {},
    raw: raw ?? null,
    meta: meta || {},
  };
}

/**
 * Compatibility wrapper: take the legacy Kick event object and wrap into canonical envelope.
 * Use this if existing Kick code is currently producing buildEvent().
 */
export function envelopeFromLegacyKickEvent(evt) {
  return createEnvelope({
    platform: "kick",
    type: evt?.kind || null,     // until we migrate to normalized types
    kind: evt?.kind || null,
    channel: evt?.channel || {},
    actor: evt?.actor || {},
    payload: evt?.data || evt?.payload || {},
    raw: evt?.raw || null,
    meta: { legacy: true },
  });
  
}
// --- Compatibility alias (DO NOT REMOVE YET) ---
// Some internal callers still expect `buildEvent()`.
// This returns the canonical envelope, NOT a legacy Kick-shaped object.
export function buildEvent(input) {
  return createEnvelope(input);
}
