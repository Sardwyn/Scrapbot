// /var/www/scrapbot/src/routes/channels.js
import express from 'express';
import { q } from '../lib/db.js';
import { ensureChannelConnected } from '../lib/wsSupervisor.js';

const router = express.Router();

/**
 * Upsert a channel row by slug and kick off a connection.
 * Body: { slug: "scraplet" }
 */
router.post('/api/channels', async (req, res) => {
  try {
    const { slug } = req.body || {};
    if (!slug || typeof slug !== 'string') {
      return res.status(400).json({ ok: false, error: 'missing slug' });
    }

    // Do NOT set id; let bigserial generate it.
    // Keep platform fixed to 'kick' for now.
    const upsertSql = `
      INSERT INTO channels (platform, channel_slug)
      VALUES ('kick', $1)
      ON CONFLICT (platform, channel_slug)
      DO UPDATE SET updated_at = now()
      RETURNING id, platform, channel_slug, chatroom_id, account_id
    `;
    const { rows } = await q(upsertSql, [slug.toLowerCase()]);
    const row = rows[0];

    // Try to connect (best-effort, don’t fail the API on connect error)
    ensureChannelConnected(slug.toLowerCase()).catch(e =>
      console.error('[channels] connect error', e?.message || e)
    );

    return res.json({ ok: true, channel: row.channel_slug });
  } catch (e) {
    // If we proxied this through nginx previously and got HTML back,
    // that caused "Unexpected token '<'". Keep this JSON-only here.
    console.error('[channels] error', e?.message || e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

export default router;
