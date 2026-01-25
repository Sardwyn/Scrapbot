// /var/www/scrapbot/src/routes/studio.js
import express from 'express';

const router = express.Router();

/**
 * Basic Studio context endpoint.
 *
 * The controller calls GET /api/studio/context to discover:
 *  - any Kick channel bindings
 *  - Scrapbot WS URL
 *  - misc user/platform info
 *
 * For now we just return a minimal stub so the controller
 * stops screaming about 404.
 */
router.get('/api/studio/context', async (req, res) => {
  try {
    const ctx = {
      // Fill these in later when you actually bind channels
      kick: null,
      scrapbot: {
        wsUrl: null, // when WS is ready, put the real wss:// URL here
      },
      user: null,
    };

    return res.json(ctx);
  } catch (e) {
    console.error('[studio] context error', e?.message || e);
    return res
      .status(500)
      .json({ ok: false, error: 'context_error' });
  }
});

export default router;
