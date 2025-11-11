// /var/www/scrapbot/src/routes/debug.js
import express from 'express';
import { q } from '../lib/db.js';

const router = express.Router();

// Simple liveness probe
router.get('/__ping', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// DB/env probe (works even if _dbinfo also exists elsewhere)
router.get('/_dbinfo', async (req, res) => {
  try {
    const r = await q('select current_database() db, current_user usr');
    res.json({ envDb: process.env.DATABASE_URL, ...r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
