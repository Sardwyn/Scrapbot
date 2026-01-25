// /src/systemCommands.js
import { enqueueFreeTTS } from "./ttsClient.js";
import {
  getFreeTTSFeature,
  isFreeTTSEnabled,
  isFreeTTSChatConfirmationsEnabled,
  setFreeTTSEnabled,
} from "./ttsFeatureCache.js";
import { sendKickChatMessage } from "./sendChat.js";

const DEFAULTS = {
  command: "!tts",
  voice_preset: "uk_male",
  min_role_kick: "everyone",
  max_chars: 144,
  cooldown_user_ms: 30_000,
  cooldown_channel_ms: 7_000,
  template: "${sender} says ${text}",
  sanitize: {
    strip_links: true,
    strip_numbers: false,
    strip_symbols: false,
    strip_emojis: true,
    collapse_repeats: true,
  },
};

const ROLE_ORDER = {
  everyone: 0,
  subscriber: 1,
  moderator: 2,
  broadcaster: 3,
};

function roleAtLeast(userRole, requiredRole) {
  const u = ROLE_ORDER[String(userRole || "everyone").toLowerCase()] ?? 0;
  const r = ROLE_ORDER[String(requiredRole || "everyone").toLowerCase()] ?? 0;
  return u >= r;
}

// Cooldowns (in-memory; creator-configurable values still apply)
const userCooldown = new Map();
const channelCooldown = new Map();

function hit(map, key, ms) {
  const now = Date.now();
  const last = map.get(key) || 0;
  if (now - last < ms) return false;
  map.set(key, now);
  return true;
}

function isPrivilegedRole(role) {
  const r = String(role || "").toLowerCase();
  return r === "broadcaster" || r === "moderator";
}

async function maybeSay(event, messageText) {
  const allowed = await isFreeTTSChatConfirmationsEnabled(event.scraplet_user_id);
  if (!allowed) return;

  await sendKickChatMessage({
    channelSlug: event.channelSlug,
    broadcasterUserId: event.broadcasterUserId,
    messageText,
    replyToMessageId: null,
    type: "bot",
  });
}

/**
 * Basic sanitization (MVP competitive).
 * We keep it simple and fast; tweak later if needed.
 */
function sanitizeText(input, cfg) {
  let s = String(input || "");

  if (cfg.strip_links) {
    // strip http(s):// and www.*
    s = s.replace(/\bhttps?:\/\/\S+/gi, " ");
    s = s.replace(/\bwww\.\S+/gi, " ");
  }

  if (cfg.strip_emojis) {
    // rough emoji strip (surrogate pairs + common ranges)
    s = s.replace(/[\u{1F000}-\u{1FAFF}]/gu, " ");
    s = s.replace(/[\u{2600}-\u{27BF}]/gu, " ");
  }

  if (cfg.strip_numbers) {
    s = s.replace(/\d+/g, " ");
  }

  if (cfg.strip_symbols) {
    // keep letters, digits, whitespace and basic punctuation
    s = s.replace(/[^a-zA-Z0-9\s.,!?'"-]/g, " ");
  }

  if (cfg.collapse_repeats) {
    // Collapse long character runs: "heyyyyyy" -> "heyy"
    s = s.replace(/(.)\1{3,}/g, "$1$1");
  }

  // normalize whitespace
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function applyTemplate(template, sender, text) {
  const t = String(template || DEFAULTS.template);
  return t
    .replaceAll("${sender}", String(sender || "someone"))
    .replaceAll("${text}", String(text || ""));
}

/**
 * Curated voice presets -> actual voice IDs used by your worker.
 * IMPORTANT:
 * - If you only have one voice working right now, point them all to that voice_id.
 * - You can expand later without changing user-facing settings.
 */
function voiceIdForPreset(preset) {
  const p = String(preset || "uk_male").toLowerCase();

  // SAFE DEFAULT that you already know works in your system:
  const SAFE = "en_GB-alba-medium";

  const map = {
    uk_male: SAFE,
    uk_female: SAFE,
    us_male: SAFE,
    us_female: SAFE,
    robot: SAFE,
    scraplet: SAFE,
  };

  return map[p] || SAFE;
}

export async function tryHandleSystemCommand(event) {
  const raw = (event.text || "").trim();
  if (!raw.startsWith("!")) return false;

  // Pull feature/settings/blacklist (cached, cheap)
  const feature = await getFreeTTSFeature({
    scrapletUserId: event.scraplet_user_id,
    platform: event.platform || "kick",
    channelSlug: event.channelSlug || "",
  });

  const tts = feature.tts || {};
  const cfg = {
    command: String(tts.command || DEFAULTS.command).trim() || DEFAULTS.command,
    voice_preset: String(tts.voice_preset || DEFAULTS.voice_preset),
    min_role_kick: String(tts.min_role_kick || DEFAULTS.min_role_kick),
    max_chars: Number.isFinite(Number(tts.max_chars)) ? Number(tts.max_chars) : DEFAULTS.max_chars,
    cooldown_user_ms: Number.isFinite(Number(tts.cooldown_user_ms)) ? Number(tts.cooldown_user_ms) : DEFAULTS.cooldown_user_ms,
    cooldown_channel_ms: Number.isFinite(Number(tts.cooldown_channel_ms)) ? Number(tts.cooldown_channel_ms) : DEFAULTS.cooldown_channel_ms,
    template: String(tts.template || DEFAULTS.template),
    sanitize: {
      strip_links: tts?.sanitize?.strip_links ?? DEFAULTS.sanitize.strip_links,
      strip_numbers: tts?.sanitize?.strip_numbers ?? DEFAULTS.sanitize.strip_numbers,
      strip_symbols: tts?.sanitize?.strip_symbols ?? DEFAULTS.sanitize.strip_symbols,
      strip_emojis: tts?.sanitize?.strip_emojis ?? DEFAULTS.sanitize.strip_emojis,
      collapse_repeats: tts?.sanitize?.collapse_repeats ?? DEFAULTS.sanitize.collapse_repeats,
    },
  };

  if (!cfg.command.startsWith("!")) cfg.command = DEFAULTS.command;

  // Parse command + args
  const [firstTok, ...rest] = raw.split(" ");
  if (firstTok.toLowerCase() !== cfg.command.toLowerCase()) return false;

  const firstArg = (rest[0] || "").toLowerCase().trim();

  // Admin controls: !tts on/off/status (uses command name configured)
  if (firstArg === "on" || firstArg === "off") {
    if (!isPrivilegedRole(event.userRole)) {
      await maybeSay(event, "Only mods/broadcaster can toggle TTS.");
      return true;
    }
    const next = firstArg === "on";
    const finalEnabled = await setFreeTTSEnabled(event.scraplet_user_id, next);
    await maybeSay(event, `Free TTS is now ${finalEnabled ? "ON" : "OFF"}.`);
    return true;
  }

  if (firstArg === "status") {
    const enabled = await isFreeTTSEnabled(event.scraplet_user_id);
    await maybeSay(event, `Free TTS is currently ${enabled ? "ON" : "OFF"}.`);
    return true;
  }

  // Normal enqueue: !tts <message>
  const messageRaw = rest.join(" ").trim();
  if (!messageRaw) return true;

  if (!feature.enabled) {
    await maybeSay(event, "Free TTS is OFF for this channel.");
    return true;
  }

  // Role gate (Kick only for now)
  if (!roleAtLeast(event.userRole, cfg.min_role_kick)) {
    await maybeSay(event, `Free TTS requires role: ${cfg.min_role_kick}.`);
    return true;
  }

  // Blacklist
  const uname = String(event.senderUsername || "").toLowerCase();
  if (uname && feature.blacklist && feature.blacklist.includes(uname)) {
    // silent by design
    return true;
  }

  // Sanitize + char limit
  const cleaned = sanitizeText(messageRaw, cfg.sanitize);
  if (!cleaned) return true;

  const maxChars = Math.max(20, Math.min(500, Math.floor(cfg.max_chars || DEFAULTS.max_chars)));
  const trimmed = cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned;

  // Cooldowns (creator-configurable)
  const userMs = Math.max(0, Math.min(300_000, Math.floor(cfg.cooldown_user_ms || DEFAULTS.cooldown_user_ms)));
  const channelMs = Math.max(0, Math.min(300_000, Math.floor(cfg.cooldown_channel_ms || DEFAULTS.cooldown_channel_ms)));

  if (userMs > 0 && !hit(userCooldown, `${event.channelSlug}:${event.senderUserId}`, userMs)) return true;
  if (channelMs > 0 && !hit(channelCooldown, event.channelSlug, channelMs)) return true;

  // Template
  const finalText = applyTemplate(cfg.template, event.senderUsername, trimmed);

  // Voice preset -> voice_id
  const voiceId = voiceIdForPreset(cfg.voice_preset);

  await enqueueFreeTTS({
    scrapletUserId: event.scraplet_user_id,
    channelSlug: event.channelSlug,
    text: finalText,
    platform: "kick",
    voicePreset: cfg.voice_preset,
    voiceId,
  });

  await maybeSay(event, "Queued ✅");
  return true;
}
