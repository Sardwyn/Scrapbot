// routes/kickEvents.js
// LEGACY: Kick events handling is now owned by the Dashboard.
// This file is kept only to avoid import errors if something requires it.

import express from 'express';

const router = express.Router();

// No-op endpoint – not used in the current architecture.
router.all('/api/legacy/kick-events-disabled', (req, res) => {
  return res.json({
    ok: false,
    error: 'Kick events are handled by the dashboard now',
  });
});

export default router;
