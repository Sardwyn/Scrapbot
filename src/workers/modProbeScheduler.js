// /var/www/scrapbot/src/workers/modProbeScheduler.js

import { q } from "../lib/db.js";
import { probeKickModerator } from "../lib/probeKickModerator.js";
import { getBotAccessToken } from "../lib/kickBotTokens.js";

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms, label = "timeout") {
  let t = null;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function listEnabledKickChannels() {
  const { rows } = await q(`
    select owner_user_id, channel_id
    from public.scrapbot_accounts
    where platform = 'kick'
      and enabled = true
    order by channel_id asc
  `);

  return (rows || [])
    .map((r) => ({
      owner_user_id: r.owner_user_id != null ? Number(r.owner_user_id) : null,
      channel_id: String(r.channel_id || "").trim().toLowerCase(),
    }))
    .filter((r) => !!r.channel_id);
}

async function upsertModResult({ channelId, modStatus, httpCode }) {
  await q(
    `
    insert into public.scrapbot_channel_status
      (platform, channel_id, mod_status, mod_http_code, mod_checked_at, updated_at)
    values
      ('kick', $1, $2, $3, now(), now())
    on conflict (platform, channel_id)
    do update set
      mod_status = excluded.mod_status,
      mod_http_code = excluded.mod_http_code,
      mod_checked_at = excluded.mod_checked_at,
      updated_at = now()
    `,
    [channelId, String(modStatus || "unknown"), Number.isFinite(httpCode) ? Number(httpCode) : null]
  );
}

async function runOnce() {
  const startedAt = Date.now();
  const channels = await withTimeout(listEnabledKickChannels(), 1500);

  if (!channels.length) {
    return { ok: true, message: "no_enabled_channels", checked: 0, updated: 0 };
  }

  // 🔑 CANONICAL TOKEN SOURCE
  const accessToken = await getBotAccessToken();

  let updated = 0;

  for (const ch of channels) {
    await sleep(150);

    const probe = await withTimeout(
      probeKickModerator({
        channelSlug: ch.channel_id,
        accessToken,
      }),
      6000
    ).catch((e) => ({
      ok: false,
      mod_status: "error",
      http_code: 0,
      note: e?.message || String(e),
    }));

    await upsertModResult({
      channelId: ch.channel_id,
      modStatus: probe.mod_status,
      httpCode: probe.http_code,
    });

    updated++;
  }

  return {
    ok: true,
    message: "ok",
    checked: channels.length,
    updated,
    took_ms: Date.now() - startedAt,
  };
}

export function startModProbeScheduler() {
  const intervalMs = Math.max(
    10_000,
    Number(process.env.MOD_PROBE_INTERVAL_MS || 60_000)
  );

  console.log("[modProbeScheduler] starting", { intervalMs });

  let inFlight = false;

  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const result = await runOnce();
      console.log("[modProbeScheduler] tick", {
        at: nowIso(),
        ...result,
      });
    } catch (e) {
      console.error("[modProbeScheduler] tick failed", e);
    } finally {
      inFlight = false;
    }
  };

  tick().catch(() => {});
  setInterval(() => tick().catch(() => {}), intervalMs);
}
