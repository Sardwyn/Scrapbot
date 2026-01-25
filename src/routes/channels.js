// /var/www/scrapbot/src/routes/channels.js
import express from "express";
import { q } from "../lib/db.js"; // scrapbot_clean DB helper
import { connectChannel, disconnectChannel } from "../lib/wsSupervisor.js";

const router = express.Router();
router.use(express.json());

/**
 * GET /api/channels
 *
 * Returns the list of kick channels Scrapbot knows about.
 * Clean-break source: public.scrapbot_accounts
 */
router.get("/", async (req, res) => {
  try {
    const { rows } = await q(`
      select
        id,
        owner_user_id,
        platform,
        channel_id,
        channel_name,
        enabled,
        created_at,
        updated_at
      from public.scrapbot_accounts
      where platform = 'kick'
      order by created_at desc
    `);

    // Maintain legacy-ish shape for existing dashboard callers
    const out = rows.map((r) => ({
      id: r.id,
      channel_slug: r.channel_id,
      slug: r.channel_id,
      enabled: !!r.enabled,
      owner_user_id: r.owner_user_id,
      account_id: null, // legacy field (public.channels had this)
      channel_name: r.channel_name,
      created_at: r.created_at,
      updated_at: r.updated_at
    }));

    return res.json({ ok: true, channels: out });
  } catch (err) {
    console.error("[channels] GET error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

/**
 * POST /api/channels
 *
 * Body:
 *   {
 *     "slug": "scraplet",
 *     "enabled": true,
 *     "owner_user_id": 4
 *   }
 *
 * Clean-break: Upsert into public.scrapbot_accounts.
 */
router.post("/", async (req, res) => {
  try {
    const slugRaw = req.body?.slug;
    const enabled = req.body?.enabled !== false;
    const ownerUserId = Number(req.body?.owner_user_id);

    const slugNorm = String(slugRaw || "").trim().toLowerCase();
    if (!slugNorm) {
      return res.status(400).json({ ok: false, error: "Missing slug" });
    }
    if (!Number.isFinite(ownerUserId) || ownerUserId <= 0) {
      return res.status(400).json({ ok: false, error: "Missing/invalid owner_user_id" });
    }

    // channel_name is NOT NULL in your schema.
    // For Kick, using the slug as the default name is fine until you later enrich it.
    const channelName = slugNorm;

    const sql = `
      insert into public.scrapbot_accounts (
        owner_user_id,
        platform,
        channel_id,
        channel_name,
        enabled
      )
      values ($1, 'kick', $2, $3, $4)
      on conflict (platform, channel_id)
      do update set
        owner_user_id = excluded.owner_user_id,
        channel_name  = excluded.channel_name,
        enabled       = excluded.enabled,
        updated_at    = now()
      returning
        id, owner_user_id, platform, channel_id, channel_name, enabled, created_at, updated_at
    `;

    const { rows } = await q(sql, [ownerUserId, slugNorm, channelName, enabled]);
    const row = rows[0];

    console.log("[channels] upsert scrapbot_accounts OK", {
      id: row.id,
      channel_id: row.channel_id,
      enabled: row.enabled,
      owner_user_id: row.owner_user_id
    });

    // Start/stop watcher immediately
    if (enabled) {
      try {
        await connectChannel(slugNorm);
      } catch (e) {
        console.error("[channels] connectChannel failed", slugNorm, e);
      }
    } else {
      try {
        await disconnectChannel(slugNorm);
      } catch (e) {
        console.error("[channels] disconnectChannel failed", slugNorm, e);
      }
    }

    // legacy-ish response
    return res.json({
      ok: true,
      channel: {
        id: row.id,
        channel_slug: row.channel_id,
        slug: row.channel_id,
        enabled: !!row.enabled,
        owner_user_id: row.owner_user_id,
        account_id: null,
        channel_name: row.channel_name,
        created_at: row.created_at,
        updated_at: row.updated_at
      }
    });
  } catch (err) {
    console.error("[channels] POST error", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

export default router;
