// src/routes/intelApi.js
import express from 'express';
import { listHotSignatures, listIncidents, listOverrides, upsertOverride } from '../stores/intelStore.js';

const router = express.Router();

// GET /api/moderation/intel/hot?platform=kick&limit=25
router.get('/api/moderation/intel/hot', async (req, res) => {
  try {
    const platform = String(req.query.platform || 'kick');
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
    const rows = await listHotSignatures({ platform, limit });
    return res.json({ ok: true, hot: rows });
  } catch (e) {
    console.error('[intelApi] hot error', e);
    return res.status(500).json({ ok: false, error: e.message || 'error' });
  }
});

// GET /api/moderation/incidents?scraplet_user_id=4&platform=kick&limit=20
router.get('/api/moderation/incidents', async (req, res) => {
  try {
    const platform = String(req.query.platform || 'kick');
    const scraplet_user_id = Number(req.query.scraplet_user_id || 0) || null;
    const channel_slug = req.query.channel_slug ? String(req.query.channel_slug).toLowerCase() : null;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const rows = await listIncidents({ scraplet_user_id, platform, channel_slug, limit });
    return res.json({ ok: true, incidents: rows });
  } catch (e) {
    console.error('[intelApi] incidents error', e);
    return res.status(500).json({ ok: false, error: e.message || 'error' });
  }
});

// GET /api/moderation/overrides?scraplet_user_id=4&platform=kick
router.get('/api/moderation/overrides', async (req, res) => {
  try {
    const platform = String(req.query.platform || 'kick');
    const scraplet_user_id = Number(req.query.scraplet_user_id || 0);
    if (!scraplet_user_id) return res.status(400).json({ ok: false, error: 'scraplet_user_id required' });

    const rows = await listOverrides({ scraplet_user_id, platform });
    return res.json({ ok: true, overrides: rows });
  } catch (e) {
    console.error('[intelApi] overrides error', e);
    return res.status(500).json({ ok: false, error: e.message || 'error' });
  }
});

// PUT /api/moderation/overrides  { scraplet_user_id, platform, signature_hash, mode, note, enabled }
router.put('/api/moderation/overrides', async (req, res) => {
  try {
    const b = req.body || {};
    const scraplet_user_id = Number(b.scraplet_user_id || 0);
    if (!scraplet_user_id) return res.status(400).json({ ok: false, error: 'scraplet_user_id required' });

    const platform = String(b.platform || 'kick');
    const signature_hash = String(b.signature_hash || '').trim();
    const mode = String(b.mode || '').trim(); // allow|ban
    if (!signature_hash) return res.status(400).json({ ok: false, error: 'signature_hash required' });
    if (mode !== 'allow' && mode !== 'ban') return res.status(400).json({ ok: false, error: 'mode must be allow|ban' });

    const note = String(b.note || '').slice(0, 200);
    const enabled = b.enabled === undefined ? true : !!b.enabled;

    const row = await upsertOverride({ scraplet_user_id, platform, signature_hash, mode, note, enabled });
    return res.json({ ok: true, override: row });
  } catch (e) {
    console.error('[intelApi] upsert override error', e);
    return res.status(500).json({ ok: false, error: e.message || 'error' });
  }
});

export default router;
