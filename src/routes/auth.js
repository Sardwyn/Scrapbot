// /var/www/scrapbot/src/routes/auth.js
import express from 'express';
import { refreshIfNeeded } from '../lib/refreshKick.js';

const router = express.Router();

/**
 * POST /refresh
 *
 * NOTE:
 * - In src/index.js this router is mounted with `app.use(authRoutes);`
 *   so the actual path on this service is POST /refresh.
 * - If you expose it externally as /auth/refresh, do that at the proxy level.
 */
router.post('/refresh', async (req, res) => {
  try {
    const owner =
      (req.body?.owner ||
        req.query?.owner ||
        req.query?.slug ||
        '')
        .toString()
        .trim() || null;

    const t = await refreshIfNeeded(owner);

    return res.json({
      ok: true,
      token_type: t.token_type || 'Bearer',
      expires_in: Number(t.expires_in || 0),
      access_token_preview: (t.access_token || '').slice(0, 12) + '…',
    });
  } catch (e) {
    console.error('[auth/refresh] error', e?.message || e);
    return res
      .status(500)
      .json({ ok: false, error: e?.message || String(e) });
  }
});

export default router;
