// src/lib/kickModeration.js
// Kick Public API moderation helpers.

import { refreshIfNeeded } from './refreshKick.js';

const KICK_API_BASE = process.env.KICK_API_BASE || 'https://api.kick.com/public/v1';

function clampInt(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, Math.floor(x)));
}

async function getBotToken() {
  // refreshIfNeeded currently refreshes the *bot* token stored in kick_tokens_bot (id=1)
  return await refreshIfNeeded('bot');
}

async function kickFetch(method, url, { token, json, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        ...(json ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      body: json ? JSON.stringify(json) : undefined,
      signal: controller.signal,
    });

    // Some endpoints return 204 No Content.
    const text = await resp.text().catch(() => '');
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    return { ok: resp.ok, status: resp.status, data };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Ban or timeout a user.
 * - duration_minutes: omit/undefined/null to BAN
 * - duration_minutes: 1..10080 for TIMEOUT
 */
export async function kickBanOrTimeout({
  broadcaster_user_id,
  user_id,
  duration_minutes,
  reason,
}) {
  const token = await getBotToken();
  const url = `${KICK_API_BASE}/moderation/bans`;

  const body = {
    broadcaster_user_id: clampInt(broadcaster_user_id, 1, 2_147_483_647),
    user_id: clampInt(user_id, 1, 2_147_483_647),
  };

  if (duration_minutes !== undefined && duration_minutes !== null) {
    body.duration = clampInt(duration_minutes, 1, 10080);
  }
  if (reason) body.reason = String(reason).slice(0, 100);

  return await kickFetch('POST', url, { token, json: body });
}

/** Unban or remove timeout */
export async function kickUnban({ broadcaster_user_id, user_id }) {
  const token = await getBotToken();
  const url = `${KICK_API_BASE}/moderation/bans`;
  const body = {
    broadcaster_user_id: clampInt(broadcaster_user_id, 1, 2_147_483_647),
    user_id: clampInt(user_id, 1, 2_147_483_647),
  };
  return await kickFetch('DELETE', url, { token, json: body });
}

/** Delete a chat message (requires moderation:chat_message:manage scope). */
export async function kickDeleteChatMessage({ message_id }) {
  const token = await getBotToken();
  const mid = String(message_id || '').trim();
  if (!mid) return { ok: false, status: 400, data: { message: 'missing message_id' } };
  const url = `${KICK_API_BASE}/chat/${encodeURIComponent(mid)}`;
  return await kickFetch('DELETE', url, { token });
}
