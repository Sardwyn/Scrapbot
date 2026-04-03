// /src/systemCommands.js
import { enqueueFreeTTS } from "./ttsClient.js";
import { startRaffle, rollRaffle, stopRaffle, getRaffleStatus } from "./workers/raffleManager.js";
import {
  getFreeTTSFeature,
  isFreeTTSEnabled,
  isFreeTTSChatConfirmationsEnabled,
  setFreeTTSEnabled,
} from "./ttsFeatureCache.js";
import { sendKickChatMessage } from "./sendChat.js";
import { loadAllCommands } from "./commandStore.js";
import { q } from "./lib/db.js";

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

// Chat command manager defaults
const CMD_DEFAULTS = {
  command: "!cmd",
  max_trigger_len: 32,
  max_response_len: 400,
  list_limit: 10,
  find_limit: 10,
  max_cd_seconds: 300,
  reserved: new Set(["!cmd", "!tts", "!help", "!commands"]),
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

/**
 * TTS-only confirmations (feature-gated).
 */
async function maybeSayTTS(event, text) {
  const allowed = await isFreeTTSChatConfirmationsEnabled(event.scraplet_user_id);
  if (!allowed) return;

  await sendKickChatMessage({
    channelSlug: event.channelSlug,
    broadcasterUserId: event.broadcasterUserId,
    text,
    replyToMessageId: null,
    type: null,
  });
}

/**
 * System replies (NOT feature-gated).
 */
async function saySystem(event, text) {
  if (!event.broadcasterUserId) {
    console.warn("[commands] reply skipped: missing broadcasterUserId", {
      channelSlug: event.channelSlug,
    });
    return;
  }
  await sendKickChatMessage({
    channelSlug: event.channelSlug,
    broadcasterUserId: event.broadcasterUserId,
    text,
    replyToMessageId: null,
    type: null,
  });
}

function eventText(event) {
  // support both legacy {text} and chat_v1 {message:{text}}
  return String(
    event?.text ??
    event?.message?.text ??
    event?.chat_v1?.message?.text ?? // if someone nested it
    ""
  ).trim();
}

/**
 * Basic sanitization (MVP competitive).
 */
function sanitizeText(input, cfg) {
  let s = String(input || "");

  if (cfg.strip_links) {
    s = s.replace(/\bhttps?:\/\/\S+/gi, " ");
    s = s.replace(/\bwww\.\S+/gi, " ");
  }

  if (cfg.strip_emojis) {
    s = s.replace(/[\u{1F000}-\u{1FAFF}]/gu, " ");
    s = s.replace(/[\u{2600}-\u{27BF}]/gu, " ");
  }

  if (cfg.strip_numbers) {
    s = s.replace(/\d+/g, " ");
  }

  if (cfg.strip_symbols) {
    s = s.replace(/[^a-zA-Z0-9\s.,!?'"-]/g, " ");
  }

  if (cfg.collapse_repeats) {
    s = s.replace(/(.)\1{3,}/g, "$1$1");
  }

  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function applyTemplate(template, sender, text) {
  const t = String(template || DEFAULTS.template);
  return t
    .replaceAll("${sender}", String(sender || "someone"))
    .replaceAll("${text}", String(text || ""));
}

function voiceIdForPreset(preset) {
  const p = String(preset || "uk_male").toLowerCase();
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

// ------------------------------
// !cmd manager helpers
// ------------------------------

function normalizeTrigger(raw) {
  const t = String(raw || "").trim();
  if (!t) return null;

  const withBang = t.startsWith("!") ? t : `!${t}`;
  const lowered = withBang.toLowerCase();

  if (!/^![a-z0-9_]{1,48}$/i.test(lowered)) return null;
  if (lowered.length > CMD_DEFAULTS.max_trigger_len) return null;

  return lowered;
}

function truncateForChat(s, maxLen) {
  const str = String(s || "");
  if (str.length <= maxLen) return str;
  return str.slice(0, Math.max(0, maxLen - 1)) + "…";
}

function normalizeRole(raw) {
  const r = String(raw || "").toLowerCase().trim();
  if (!r) return null;
  if (!(r in ROLE_ORDER)) return null;
  return r;
}

function parseCooldownSeconds(raw) {
  const n = Number(String(raw || "").trim());
  if (!Number.isFinite(n)) return null;
  const s = Math.floor(n);
  if (s < 0) return null;
  return Math.min(s, CMD_DEFAULTS.max_cd_seconds);
}

async function ensureScrapbotAccountIdForEvent(event) {
  const platform = String(event.platform || "kick").toLowerCase();
  const channelId = String(event.channelSlug || "").toLowerCase().trim();
  if (!channelId) throw new Error("missing_channel_id");

  const ownerUserId = Number(event.scraplet_user_id || 0) || 0;
  const channelName = channelId;

  const broadcasterUserId =
    event.broadcasterUserId != null && String(event.broadcasterUserId).trim()
      ? Number(event.broadcasterUserId)
      : null;

  const sql = `
    INSERT INTO public.scrapbot_accounts
      (owner_user_id, platform, channel_id, channel_name, enabled, broadcaster_user_id)
    VALUES
      ($1, $2, $3, $4, true, $5)
    ON CONFLICT (platform, channel_id)
    DO UPDATE SET
      updated_at = now(),
      channel_name = EXCLUDED.channel_name,
      broadcaster_user_id = COALESCE(EXCLUDED.broadcaster_user_id, public.scrapbot_accounts.broadcaster_user_id)
    RETURNING id
  `;

  const r = await q(sql, [ownerUserId, platform, channelId, channelName, broadcasterUserId]);
  return r.rows?.[0]?.id ?? null;
}

async function handleCmdManager(event) {
  const raw = eventText(event);
  if (!raw.startsWith("!")) return { handled: false };

  const [head, sub, ...rest] = raw.split(" ");
  if (head.toLowerCase() !== CMD_DEFAULTS.command) return { handled: false };

  if (!isPrivilegedRole(event.userRole)) {
    return { handled: true, reply: "Only mods/broadcaster can manage commands." };
  }

  const action = String(sub || "").toLowerCase().trim();

  if (!action || action === "help") {
    return {
      handled: true,
      reply:
        "Usage: !cmd add !name text | !cmd set !name text | !cmd del !name confirm | !cmd show !name | !cmd list | !cmd find query | !cmd perm !name role | !cmd cd !name seconds",
    };
  }

  const accountId = await ensureScrapbotAccountIdForEvent(event);
  if (!accountId) return { handled: true, reply: "⚠️ Could not resolve channel account." };

  // REMOVE AFTER TESTING: log account resolution for debugging

  console.log("[cmdManager] account resolved", {
  accountId,
  owner: event.scraplet_user_id,
  platform: event.platform,
  channelSlug: event.channelSlug,
});



  // list (now includes role+cd)
  if (action === "list") {
    const r = await q(
      `
        SELECT trigger_pattern, role, cooldown_seconds
        FROM public.scrapbot_commands
        WHERE account_id = $1 AND enabled = true
        ORDER BY trigger_pattern
        LIMIT $2
      `,
      [accountId, CMD_DEFAULTS.list_limit]
    );

    const items = (r.rows || []).map((x) => {
      const trig = x.trigger_pattern;
      const role = x.role || "everyone";
      const cd = Number(x.cooldown_seconds || 0) || 0;
      return cd > 0 ? `${trig}(${role},${cd}s)` : `${trig}(${role})`;
    });

    if (!items.length) return { handled: true, reply: "No commands set for this channel yet." };

    return { handled: true, reply: `Commands: ${items.join(" ")} (manage more in dashboard)` };
  }

  // find
  if (action === "find" || action === "search") {
    const query = rest.join(" ").trim();
    if (!query) return { handled: true, reply: "Usage: !cmd find <query>" };

    const r = await q(
      `
        SELECT trigger_pattern
        FROM public.scrapbot_commands
        WHERE account_id = $1
          AND enabled = true
          AND (trigger_pattern ILIKE $2 OR name ILIKE $2)
        ORDER BY trigger_pattern
        LIMIT $3
      `,
      [accountId, `%${query}%`, CMD_DEFAULTS.find_limit]
    );

    const items = (r.rows || []).map((x) => x.trigger_pattern).filter(Boolean);
    if (!items.length) return { handled: true, reply: `No matches for "${query}".` };
    return { handled: true, reply: `Matches: ${items.join(" ")}` };
  }

  // All remaining actions require a trigger
  const trigRaw = rest[0] || "";
  const trigger = normalizeTrigger(trigRaw);
  if (!trigger) {
    return { handled: true, reply: "Invalid trigger. Example: !cmd set !discord https://…" };
  }

  if (CMD_DEFAULTS.reserved.has(trigger)) {
    return { handled: true, reply: `⚠️ ${trigger} is reserved.` };
  }

  // show
  if (action === "show") {
    const r = await q(
      `
        SELECT response_payload, role, cooldown_seconds, enabled
        FROM public.scrapbot_commands
        WHERE account_id = $1 AND trigger_pattern = $2
      `,
      [accountId, trigger]
    );

    const row = r.rows?.[0];
    if (!row) return { handled: true, reply: `No such command: ${trigger}` };

    const text = row?.response_payload?.text ?? row?.response_payload?.message ?? null;
    const shown = truncateForChat(text ?? "[non-text payload]", 220);

    return {
      handled: true,
      reply: `${trigger} → ${shown} (role=${row.role}, cd=${row.cooldown_seconds}s, enabled=${row.enabled ? "yes" : "no"})`,
    };
  }

  // delete (confirm required)
  if (action === "del" || action === "delete" || action === "rm") {
    const confirm = String(rest[1] || "").toLowerCase().trim() === "confirm";
    if (!confirm) {
      return { handled: true, reply: `Confirm delete: !cmd del ${trigger} confirm` };
    }

    const r = await q(
      `
        DELETE FROM public.scrapbot_commands
        WHERE account_id = $1 AND trigger_pattern = $2
        RETURNING id
      `,
      [accountId, trigger]
    );

    if (!r.rows?.length) return { handled: true, reply: `No such command: ${trigger}` };

    await loadAllCommands();
    return { handled: true, reply: `🗑️ Deleted ${trigger}` };
  }

  // perm
  if (action === "perm" || action === "role") {
    const newRole = normalizeRole(rest[1] || "");
    if (!newRole) {
      return { handled: true, reply: "Usage: !cmd perm !name everyone|subscriber|moderator|broadcaster" };
    }

    const r = await q(
      `
        UPDATE public.scrapbot_commands
        SET role = $3, updated_at = now()
        WHERE account_id = $1 AND trigger_pattern = $2
        RETURNING id
      `,
      [accountId, trigger, newRole]
    );

    if (!r.rows?.length) return { handled: true, reply: `No such command: ${trigger}` };

    await loadAllCommands();
    return { handled: true, reply: `🔒 ${trigger} role set to ${newRole}` };
  }

  // cooldown
  if (action === "cd" || action === "cooldown") {
    const secs = parseCooldownSeconds(rest[1] || "");
    if (secs == null) return { handled: true, reply: "Usage: !cmd cd !name <seconds> (0 disables)" };

    const r = await q(
      `
        UPDATE public.scrapbot_commands
        SET cooldown_seconds = $3, updated_at = now()
        WHERE account_id = $1 AND trigger_pattern = $2
        RETURNING id
      `,
      [accountId, trigger, secs]
    );

    if (!r.rows?.length) return { handled: true, reply: `No such command: ${trigger}` };

    await loadAllCommands();
    return { handled: true, reply: `⏱️ ${trigger} cooldown set to ${secs}s` };
  }

  // add/set require response text
  const responseText = rest.slice(1).join(" ").trim();
  if (!responseText) {
    return { handled: true, reply: "Missing response text. Example: !cmd set !rules Be kind." };
  }

  const cleanedResp = truncateForChat(responseText, CMD_DEFAULTS.max_response_len);
  const payload = JSON.stringify({ text: cleanedResp });

  const name = trigger.replace(/^!/, "");
  const role = "everyone";
  const cooldown_seconds = 0;

  if (action === "add") {
    const exists = await q(
      `SELECT id FROM public.scrapbot_commands WHERE account_id=$1 AND trigger_pattern=$2`,
      [accountId, trigger]
    );
    if (exists.rows?.length) {
      return { handled: true, reply: `⚠️ ${trigger} already exists. Use !cmd set ${trigger} ...` };
    }

    await q(
      `
        INSERT INTO public.scrapbot_commands
          (account_id, name, trigger_pattern, trigger_type, response_type, response_payload, role, cooldown_seconds, enabled)
        VALUES
          ($1, $2, $3, 'prefix', 'text', $4::jsonb, $5, $6, true)
      `,
      [accountId, name, trigger, payload, role, cooldown_seconds]
    );

    await loadAllCommands();
    return { handled: true, reply: `✅ Added ${trigger}` };
  }

  if (action === "set" || action === "upsert" || action === "edit") {
    await q(
      `
        INSERT INTO public.scrapbot_commands
          (account_id, name, trigger_pattern, trigger_type, response_type, response_payload, role, cooldown_seconds, enabled)
        VALUES
          ($1, $2, $3, 'prefix', 'text', $4::jsonb, $5, $6, true)
        ON CONFLICT (account_id, trigger_pattern)
        DO UPDATE SET
          name = EXCLUDED.name,
          response_payload = EXCLUDED.response_payload,
          role = public.scrapbot_commands.role, -- preserve existing perm on set
          cooldown_seconds = public.scrapbot_commands.cooldown_seconds, -- preserve existing cd on set
          enabled = true,
          updated_at = now()
      `,
      [accountId, name, trigger, payload, role, cooldown_seconds]
    );

    await loadAllCommands();
    return { handled: true, reply: `✏️ Updated ${trigger}` };
  }

  return { handled: true, reply: "Unknown action. Try: !cmd help" };
}

export async function tryHandleSystemCommand(event) {
  const raw = eventText(event);
  if (!raw.startsWith("!")) return false;

  // ------------------------------
  // !cmd manager (mods/broadcaster) — NOT TTS-gated
  // ------------------------------
  try {
    const cmd = await handleCmdManager(event);
    if (cmd?.handled) {
      if (cmd.reply) await saySystem(event, cmd.reply);
      return true;
    }
  } catch (e) {
    console.error("[cmdManager] failed", e?.message || e);
    await saySystem(event, "⚠️ Command manager error.");
    return true;
  }

  // ------------------------------
  // Raffle commands (!raffle start|roll|stop|status)
  // ------------------------------
  if (raw.toLowerCase().startsWith('!raffle')) {
    const parts = raw.trim().split(/\s+/);
    const sub = (parts[1] || '').toLowerCase();
    const channelSlug = event.channelSlug || '';
    const ownerUserId = event.scraplet_user_id;
    const isMod = event.role === 'moderator' || event.role === 'broadcaster' || event.isBroadcaster;

    if (!isMod) {
      await saySystem(event, '⚠️ Only mods can manage the raffle.');
      return true;
    }

    try {
      if (sub === 'start') {
        const anim = parts[2] || '';
        const result = await startRaffle(channelSlug, ownerUserId, anim || undefined);
        await saySystem(event, result.message);
        return true;
      }
      if (sub === 'roll') {
        const anim = parts[2] || '';
        const result = await rollRaffle(channelSlug, anim || undefined);
        await saySystem(event, result.message);
        return true;
      }
      if (sub === 'stop' || sub === 'end') {
        const result = await stopRaffle(channelSlug);
        await saySystem(event, result.message);
        return true;
      }
      if (sub === 'status') {
        const raffle = getRaffleStatus(channelSlug);
        if (!raffle) { await saySystem(event, 'No active raffle.'); return true; }
        await saySystem(event, `Raffle: ${raffle.status}, ${raffle.entrants.size} entries, join with ${raffle.config.joinCommand}`);
        return true;
      }
      // Default: show help
      await saySystem(event, '!raffle start [wheel|slot|scramble] | !raffle roll | !raffle stop | !raffle status');
      return true;
    } catch (e) {
      console.error('[raffle cmd] failed', e?.message || e);
      await saySystem(event, '⚠️ Raffle error.');
      return true;
    }
  }

  // ------------------------------
  // TTS system command
  // ------------------------------
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
    cooldown_user_ms: Number.isFinite(Number(tts.cooldown_user_ms))
      ? Number(tts.cooldown_user_ms)
      : DEFAULTS.cooldown_user_ms,
    cooldown_channel_ms: Number.isFinite(Number(tts.cooldown_channel_ms))
      ? Number(tts.cooldown_channel_ms)
      : DEFAULTS.cooldown_channel_ms,
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

  const [firstTok, ...rest] = raw.split(" ");
  if (firstTok.toLowerCase() !== cfg.command.toLowerCase()) return false;

  const firstArg = (rest[0] || "").toLowerCase().trim();

  if (firstArg === "on" || firstArg === "off") {
    if (!isPrivilegedRole(event.userRole)) {
      await maybeSayTTS(event, "Only mods/broadcaster can toggle TTS.");
      return true;
    }
    const next = firstArg === "on";
    const finalEnabled = await setFreeTTSEnabled(event.scraplet_user_id, next);
    await maybeSayTTS(event, `Free TTS is now ${finalEnabled ? "ON" : "OFF"}.`);
    return true;
  }

  if (firstArg === "status") {
    const enabled = await isFreeTTSEnabled(event.scraplet_user_id);
    await maybeSayTTS(event, `Free TTS is currently ${enabled ? "ON" : "OFF"}.`);
    return true;
  }

  const messageRaw = rest.join(" ").trim();
  if (!messageRaw) return true;

  if (!feature.enabled) {
    await maybeSayTTS(event, "Free TTS is OFF for this channel.");
    return true;
  }

  if (!roleAtLeast(event.userRole, cfg.min_role_kick)) {
    await maybeSayTTS(event, `Free TTS requires role: ${cfg.min_role_kick}.`);
    return true;
  }

  const uname = String(event.senderUsername || "").toLowerCase();
  if (uname && feature.blacklist && feature.blacklist.includes(uname)) {
    return true;
  }

  const cleaned = sanitizeText(messageRaw, cfg.sanitize);
  if (!cleaned) return true;

  const maxChars = Math.max(20, Math.min(500, Math.floor(cfg.max_chars || DEFAULTS.max_chars)));
  const trimmed = cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned;

  const userMs = Math.max(0, Math.min(300_000, Math.floor(cfg.cooldown_user_ms || DEFAULTS.cooldown_user_ms)));
  const channelMs = Math.max(0, Math.min(300_000, Math.floor(cfg.cooldown_channel_ms || DEFAULTS.cooldown_channel_ms)));

  if (userMs > 0 && !hit(userCooldown, `${event.channelSlug}:${event.senderUserId}`, userMs)) return true;
  if (channelMs > 0 && !hit(channelCooldown, event.channelSlug, channelMs)) return true;

  const finalText = applyTemplate(cfg.template, event.senderUsername, trimmed);
  const voiceId = voiceIdForPreset(cfg.voice_preset);

  await enqueueFreeTTS({
    scrapletUserId: event.scraplet_user_id,
    channelSlug: event.channelSlug,
    text: finalText,
    platform: "kick",
    voicePreset: cfg.voice_preset,
    voiceId,
    requestedByUsername: event.senderUsername || null,
  });

  await maybeSayTTS(event, "Queued ✅");
  return true;
}