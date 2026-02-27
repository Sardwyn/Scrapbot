// /var/www/scraplet/scrapbot/src/routes/status.js
import express from "express";
import { q } from "../lib/db.js";
import { metricsRecent } from "../lib/metrics.js";
import { probeKickModerator } from "../lib/probeKickModerator.js";
import { getBotAccessToken } from "../lib/kickBotTokens.js";

console.log("[statusRoutes] module loaded ✅ (status.js)");

const router = express.Router();

// NOTE: index.js already has express.json() globally.
// Keeping this OFF avoids double-parsing weirdness.
router.use(express.urlencoded({ extended: true }));

function nowIso() {
  return new Date().toISOString();
}

function isFresh(ts, windowMs) {
  if (!ts) return false;
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= windowMs;
}

function withTimeout(promise, ms, label = "timeout") {
  let t = null;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function deriveLastEventAtByChannel(recentItems) {
  const last = new Map(); // key = platform:slug -> ISO ts
  const items = Array.isArray(recentItems) ? recentItems : [];

  for (const it of items) {
    const platform = String(it.platform || "kick").toLowerCase();
    const slug = String(it.channelSlug || "").toLowerCase();
    if (!slug) continue;

    const ts = it.ts ? new Date(it.ts).toISOString() : null;
    if (!ts) continue;

    const key = `${platform}:${slug}`;
    if (!last.has(key)) last.set(key, ts); // newest-first wins
  }

  return last;
}

// Smoke route so you can prove the router is mounted
router.get("/", (_req, res) => {
  res.json({ ok: true, now: nowIso(), service: "statusRoutes" });
});

/**
 * POST /api/status/probe-mod
 * Body:
 *  { "channel_id":"scraplet", "broadcaster_user_id":1017792 }
 */
router.post("/probe-mod", express.json(), async (req, res) => {
  const started = Date.now();
  const reqId = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;

  try {
    const { channel_id, broadcaster_user_id } = req.body || {};
    const channelId = String(channel_id || "").trim().toLowerCase();
    const bId = Number(broadcaster_user_id);

    console.log(`[statusRoutes] [probe-mod] hit ✅ reqId=${reqId}`, {
      channelId,
      broadcaster_user_id: bId,
    });

    if (!channelId || !Number.isFinite(bId) || bId <= 0) {
      return res.status(400).json({ ok: false, error: "Missing/invalid params", reqId });
    }

    const accessToken = await withTimeout(getBotAccessToken(), 1500, "bot_token_timeout");

    const probe = await withTimeout(
      probeKickModerator({
        channelSlug: channelId,
        broadcasterUserId: bId,
        accessToken,
      }),
      3500,
      "probe_timeout"
    );

    let db_ok = true;
    try {
      await withTimeout(
        q(
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
          [channelId, probe.mod_status, probe.http_code ?? null]
        ),
        1200,
        "status_upsert_timeout"
      );
    } catch (err) {
      db_ok = false;
      console.error(`[statusRoutes] [probe-mod] DB write failed reqId=${reqId}`, err);
    }

    const took_ms = Date.now() - started;

    console.log(`[statusRoutes] [probe-mod] done ✅ reqId=${reqId} took_ms=${took_ms}`, {
      probe: { ok: probe.ok, mod_status: probe.mod_status, http_code: probe.http_code },
      db_ok,
    });

    return res.json({ ok: true, reqId, took_ms, db_ok, probe });
  } catch (err) {
    console.error(`[statusRoutes] [probe-mod] ERROR reqId=${reqId}`, err);
    return res.status(500).json({ ok: false, error: err?.message || String(err), reqId });
  }
});

/**
 * GET /api/status/channels
 * Optional:
 *   ?owner_user_id=4
 *   ?platform=kick
 */
router.get("/channels", async (req, res) => {
  try {
    const platform = String(req.query.platform || "kick").toLowerCase();
    const ownerUserId = req.query.owner_user_id ? Number(req.query.owner_user_id) : null;

    const params = [platform];
    let where = `where a.platform = $1`;

    if (Number.isFinite(ownerUserId) && ownerUserId > 0) {
      params.push(ownerUserId);
      where += ` and a.owner_user_id = $${params.length}`;
    }

    const { rows: accounts } = await q(
      `
      select
        a.owner_user_id,
        a.platform,
        a.channel_id,
        a.channel_name,
        a.enabled,

        s.mod_status,
        s.mod_http_code,
        s.mod_checked_at,
        s.last_event_at as persisted_last_event_at
      from public.scrapbot_accounts a
      left join public.scrapbot_channel_status s
        on s.platform = a.platform
       and s.channel_id = a.channel_id
      ${where}
      order by a.channel_id asc
      `,
      params
    );

    const recent = metricsRecent({ limit: 500, order: "newest" });
    const lastByChan = deriveLastEventAtByChannel(recent?.items || []);

    const channels = accounts.map((a) => {
      const slug = String(a.channel_id || "").toLowerCase();
      const key = `${String(a.platform || "kick").toLowerCase()}:${slug}`;

      const derivedLast = lastByChan.get(key) || null;
      const persistedLast = a.persisted_last_event_at
        ? new Date(a.persisted_last_event_at).toISOString()
        : null;

      const last_event_at = derivedLast || persistedLast;

      const modCheckedIso = a.mod_checked_at ? new Date(a.mod_checked_at).toISOString() : null;

      // "capable" = we have a recent successful authority probe (doesn't imply we're currently ingesting chat)
      const capable =
        String(a.mod_status || "unknown").toLowerCase() === "ok" &&
        isFresh(modCheckedIso, 10 * 60 * 1000); // 10m

      // Optional: "active_recent" = we have observed activity recently (purely informational)
      const active_recent = isFresh(last_event_at, 2 * 60 * 1000); // 2m

      return {
        platform: a.platform,
        channel_slug: slug,
        channel_name: a.channel_name,
        owner_user_id: a.owner_user_id,
        enabled: !!a.enabled,

        capable,
        capable_checked_at: modCheckedIso,

        active_recent,
        last_event_at,

        mod_status: a.mod_status || "unknown",
        mod_http_code: a.mod_http_code ?? null,
        mod_checked_at: modCheckedIso,
      };
    });

    return res.json({ ok: true, now: nowIso(), channels });
  } catch (err) {
    console.error("[statusRoutes] GET /channels error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

/**
 * POST /api/status/mod-result
 * Body:
 * {
 *   "platform":"kick",
 *   "channel_id":"scraplet",
 *   "mod_status":"ok",
 *   "mod_http_code":400
 * }
 */
router.post("/mod-result", express.json(), async (req, res) => {
  try {
    const platform = String(req.body?.platform || "kick").toLowerCase();
    const channelId = String(req.body?.channel_id || "").trim().toLowerCase();
    const modStatus = String(req.body?.mod_status || "unknown").trim().toLowerCase();
    const modHttpCode = req.body?.mod_http_code != null ? Number(req.body.mod_http_code) : null;

    if (!channelId) return res.status(400).json({ ok: false, error: "Missing channel_id" });

    await q(
      `
      insert into public.scrapbot_channel_status
        (platform, channel_id, mod_status, mod_http_code, mod_checked_at, updated_at)
      values
        ($1, $2, $3, $4, now(), now())
      on conflict (platform, channel_id)
      do update set
        mod_status = excluded.mod_status,
        mod_http_code = excluded.mod_http_code,
        mod_checked_at = excluded.mod_checked_at,
        updated_at = now()
      `,
      [platform, channelId, modStatus, Number.isFinite(modHttpCode) ? modHttpCode : null]
    );

    return res.json({ ok: true, now: nowIso() });
  } catch (err) {
    console.error("[statusRoutes] POST /mod-result error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

export default router;
