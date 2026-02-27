// /var/www/scrapbot/src/routes/debug.js
import express from 'express';

const router = express.Router();

/**
 * GET /api/debug/status
 * Used by dashboard to verify connectivity.
 */
router.get('/api/debug/status', (req, res) => {
  return res.json({
    ok: true,
    service: 'scrapbot',
    now: new Date().toISOString(),
    db: { ok: true } // Basic check
  });
});

/**
 * GET /api/debug/event/test
 *
 * 1) Returns a JSON debug payload so you can curl it.
 * 2) Tries to forward a test event into the Dashboard event-ingest endpoint
 *    so the Studio controller can see it via SSE.
 */
router.get('/api/debug/event/test', async (req, res) => {
  const dashboardIngestUrl =
    process.env.DASHBOARD_INGEST_URL ||
    'https://scraplet.store/dashboard/api/events/ingest';

  const eventPayload = {
    source: 'scrapbot',
    type: 'debug.test',
    payload: {
      message: 'Test debug event from Scrapbot',
      at: new Date().toISOString(),
    },
  };

  let forwardResult = null;

  try {
    const resp = await fetch(dashboardIngestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(eventPayload),
    });

    const text = await resp.text();
    forwardResult = {
      status: resp.status,
      ok: resp.ok,
      body: (() => {
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      })(),
    };
  } catch (err) {
    console.error('[Scrapbot] debug forward error -> dashboard:', err.message);
    forwardResult = { error: err.message };
  }

  return res.json({
    ok: true,
    route: '/api/debug/event/test',
    forwardedTo: dashboardIngestUrl,
    event: eventPayload,
    forwardResult,
  });
});

export default router;
