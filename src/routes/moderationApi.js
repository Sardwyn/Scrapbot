// src/routes/moderationApi.js
import express from 'express';
import db from '../lib/db.js';
import { evaluateModeration } from '../moderationRuntime.js';
import { getModerationSettings, clearSettingsCache, evaluateFloodGuard } from '../lib/floodGuard.js';
import { channelPulseTrack } from '../lib/channelPulse.js';
import { evaluateSwarm } from '../moderation/swarmGuard.js';
import { shouldAutoHostileAction } from '../stores/trustStore.js';

const router = express.Router();

function asInt(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function asBool(v, fallback = false) {
  if (v === true || v === false) return v;
  if (typeof v === 'string') {
    const s = v.toLowerCase().trim();
    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no') return false;
  }
  return fallback;
}

function normChannelSlug(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase().replace(/^@+/, "");
  return s ? s : null;
}


function getSessionUserId(req) {
  // Try a bunch of common shapes without assuming your auth middleware.
  const s = req?.session;
  const u = req?.user || s?.user || s?.sessionUser || null;
  const candidates = [
    req?.user_id,
    req?.userId,
    u?.id,
    u?.user_id,
    s?.user_id,
    s?.userId,
    s?.uid,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function getUserIdFrom(req, explicitId) {
  const n = Number(explicitId);
  if (Number.isFinite(n) && n > 0) return n;
  return getSessionUserId(req);
}

// -------------------------
// Rules
// -------------------------

router.get('/api/moderation/rules', async (req, res) => {
  try {
    const scraplet_user_id = getUserIdFrom(req, asInt(req.query.scraplet_user_id));
    const platform = String(req.query.platform || 'kick').toLowerCase();

    if (!scraplet_user_id) {
      return res.status(400).json({ ok: false, error: 'scraplet_user_id required' });
    }

    const { rows } = await db.query(
      `
      SELECT
        id,
        scraplet_user_id,
        platform,
        rule_type,
        rule_value,
        action,
        duration_seconds,
        enabled,
        created_at,
        updated_at,
        channel_slug,              -- leave NULL as NULL
        COALESCE(ignore_mods, TRUE) AS ignore_mods,
        COALESCE(priority, 1000)    AS priority
      FROM public.scrapbot_moderation_rules
      WHERE scraplet_user_id = $1
        AND platform = $2
      ORDER BY priority ASC, id ASC
      `,
      [scraplet_user_id, platform]
    );

    return res.json({ ok: true, rules: rows });
  } catch (err) {
    console.error('[moderationApi] list rules error', err);
    return res.status(500).json({ ok: false, error: err.message || 'internal error' });
  }
});


router.post('/api/moderation/rules', async (req, res) => {
  try {
    const b = req.body || {};
    const scraplet_user_id = getUserIdFrom(req, asInt(b.scraplet_user_id));
    const platform = String(b.platform || 'kick').toLowerCase();

    if (!scraplet_user_id) return res.status(400).json({ ok: false, error: 'scraplet_user_id required' });

    const rule_type = String(b.rule_type || '').trim();
    const rule_value = String(b.rule_value || '').trim();
    const action = String(b.action || 'timeout').trim().toLowerCase();
    const duration_seconds = asInt(b.duration_seconds, 0) || 0;
    const enabled = asBool(b.enabled, true);
    const channel_slug = normChannelSlug(b.channel_slug);

    const ignore_mods = asBool(b.ignore_mods, true);
    const priority = asInt(b.priority, 1000);

    if (!rule_type) return res.status(400).json({ ok: false, error: 'rule_type required' });
    if (!rule_value) return res.status(400).json({ ok: false, error: 'rule_value required' });

    const { rows } = await db.query(
      `
      INSERT INTO public.scrapbot_moderation_rules
        (scraplet_user_id, platform, rule_type, rule_value, action, duration_seconds, enabled, channel_slug, ignore_mods, priority)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
      `,
      [scraplet_user_id, platform, rule_type, rule_value, action, duration_seconds, enabled, channel_slug, ignore_mods, priority]
    );

    return res.json({ ok: true, rule: rows[0] });
  } catch (err) {
    console.error('[moderationApi] create rule error', err);
    return res.status(500).json({ ok: false, error: err.message || 'internal error' });
  }
});

router.put('/api/moderation/rules/:id', async (req, res) => {
  try {
    const id = asInt(req.params.id);
    const b = req.body || {};

    if (!id) return res.status(400).json({ ok: false, error: 'id required' });

    const fields = {
      rule_type: b.rule_type,
      rule_value: b.rule_value,
      action: b.action,
      duration_seconds: b.duration_seconds,
      enabled: b.enabled,
      channel_slug: b.channel_slug,
      ignore_mods: b.ignore_mods,
      priority: b.priority,
    };

    const setParts = [];
    const values = [];
    let i = 1;

    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;

      if (k === 'duration_seconds' || k === 'priority') {
        setParts.push(`${k} = $${i++}`);
        values.push(asInt(v, 0));
      } else if (k === 'enabled' || k === 'ignore_mods') {
        setParts.push(`${k} = $${i++}`);
        values.push(asBool(v, false));
      } else if (k === 'action') {
  setParts.push(`${k} = $${i++}`);
  values.push(String(v || '').trim().toLowerCase());
} else if (k === 'channel_slug') {
  setParts.push(`${k} = $${i++}`);
  values.push(normChannelSlug(v));
} else {
  setParts.push(`${k} = $${i++}`);
  values.push(String(v || '').trim());
}

    }

    if (setParts.length === 0) {
      return res.status(400).json({ ok: false, error: 'no fields to update' });
    }

    setParts.push(`updated_at = NOW()`);

    values.push(id);

    const { rows } = await db.query(
      `
      UPDATE public.scrapbot_moderation_rules
      SET ${setParts.join(', ')}
      WHERE id = $${i}
      RETURNING *
      `,
      values
    );

    if (!rows[0]) return res.status(404).json({ ok: false, error: 'rule not found' });

    return res.json({ ok: true, rule: rows[0] });
  } catch (err) {
    console.error('[moderationApi] update rule error', err);
    return res.status(500).json({ ok: false, error: err.message || 'internal error' });
  }
});

router.delete('/api/moderation/rules/:id', async (req, res) => {
  try {
    const id = asInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });

    await db.query(`DELETE FROM public.scrapbot_moderation_rules WHERE id = $1`, [id]);

    return res.json({ ok: true });
  } catch (err) {
    console.error('[moderationApi] delete rule error', err);
    return res.status(500).json({ ok: false, error: err.message || 'internal error' });
  }
});

// -------------------------
// Test
// -------------------------

router.post('/api/moderation/test', async (req, res) => {
  try {
    const b = req.body || {};
    const scraplet_user_id = getUserIdFrom(req, asInt(b.scraplet_user_id));
    const platform = String(b.platform || 'kick').toLowerCase();

    if (!scraplet_user_id) return res.status(400).json({ ok: false, error: 'scraplet_user_id required' });

    const decision = await evaluateModeration({
      platform,
      scraplet_user_id,
      channelSlug: String(b.channelSlug || ''),
      text: String(b.text || ''),
      senderUsername: String(b.senderUsername || 'tester'),
      userRole: String(b.userRole || 'everyone'),
      meta: b.meta || {},
    });

    return res.json({ ok: true, decision });
  } catch (err) {
    console.error('[moderationApi] test error', err);
    return res.status(500).json({ ok: false, error: err.message || 'internal error' });
  }
});

// POST /api/moderation/explain
// Non-mutating: returns a human-friendly explanation + raw decision for a hypothetical message.
// body: { platform, text, senderUsername?, userRole?, channelSlug? }
router.post('/api/moderation/explain', async (req, res) => {
  try {
    const b = req.body || {};
    const scraplet_user_id = getUserIdFrom(req, asInt(b.scraplet_user_id));
    const platform = String(b.platform || 'kick').toLowerCase();

    if (!scraplet_user_id) {
      return res.status(400).json({ ok: false, error: 'scraplet_user_id required' });
    }

    const text = String(b.text || '');
    const senderUsername = String(b.senderUsername || 'tester');
    const userRole = String(b.userRole || 'everyone');
    const channelSlug = String(b.channelSlug || '');

    const decision = await evaluateModeration({
      platform,
      scraplet_user_id,
      channelSlug,
      text,
      senderUsername,
      userRole,
      meta: b.meta || {},
    });

    if (!decision) {
      return res.json({
        ok: true,
        matched: false,
        explain: {
          summary: 'No rules matched',
          steps: [
            { stage: 'rules', matched: false, note: 'No enabled rules matched this message.' },
          ],
        },
      });
    }

    const rule = decision.rule || null;
    const exp = decision.explain || {};
    const summaryBits = [];

    if (rule?.rule_type && rule?.rule_value) {
      summaryBits.push(`Matched rule ${rule.rule_type}: "${rule.rule_value}"`);
    } else {
      summaryBits.push('Matched a rule');
    }

    if (decision.action === 'timeout') summaryBits.push(`Action timeout (${decision.duration_seconds}s)`);
    else summaryBits.push(`Action ${decision.action}`);

    if (exp.match_reason) summaryBits.push(`Why: ${exp.match_reason}`);

    return res.json({
      ok: true,
      matched: true,
      action: decision.action,
      duration_seconds: decision.duration_seconds,
      rule,
      explain: {
        summary: summaryBits.join(' · '),
        steps: [
          { stage: 'rules', matched: true, rule, note: exp.match_reason || '' },
          { stage: 'decision', matched: true, action: decision.action, duration_seconds: decision.duration_seconds },
        ],
      },
      decision,
    });
  } catch (err) {
    console.error('[moderationApi] explain error', err);
    return res.status(500).json({ ok: false, error: err.message || 'internal error' });
  }
});

// -------------------------
// Activity
// -------------------------

router.get('/api/moderation/activity', async (req, res) => {
  try {
    const scraplet_user_id = getUserIdFrom(req, asInt(req.query.scraplet_user_id));
    const platform = String(req.query.platform || 'kick').toLowerCase();
    const limit = Math.min(asInt(req.query.limit, 100) || 100, 500);
    const onlyMatched = asBool(req.query.onlyMatched, false);

    if (!scraplet_user_id) {
      return res.status(400).json({ ok: false, error: 'scraplet_user_id required' });
    }

    const where = [`scraplet_user_id = $1`, `platform = $2`];
    const vals = [scraplet_user_id, platform];
    let idx = 3;

    if (onlyMatched) where.push(`matched = TRUE`);

    const { rows } = await db.query(
      `
      SELECT *
      FROM public.scrapbot_moderation_events
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${idx}
      `,
      [...vals, limit]
    );

    return res.json({ ok: true, events: rows });
  } catch (err) {
    console.error('[moderationApi] activity error', err);
    return res.status(500).json({ ok: false, error: err.message || 'internal error' });
  }
});

// -------------------------
// Settings
// -------------------------

router.get('/api/moderation/settings', async (req, res) => {
  try {
    const scraplet_user_id = getUserIdFrom(req, asInt(req.query.scraplet_user_id));
    const platform = String(req.query.platform || 'kick').toLowerCase();

    if (!scraplet_user_id) {
      return res.status(400).json({ ok: false, error: 'scraplet_user_id required' });
    }

    const settings = await getModerationSettings(scraplet_user_id, platform);
    return res.json({ ok: true, settings });
  } catch (err) {
    console.error('[moderationApi] settings get error', err);
    return res.status(500).json({ ok: false, error: err.message || 'internal error' });
  }
});

router.put('/api/moderation/settings', async (req, res) => {
  try {
    const b = req.body || {};
    const scraplet_user_id = getUserIdFrom(req, asInt(b.scraplet_user_id));
    const platform = String(b.platform || 'kick').toLowerCase();

    if (!scraplet_user_id) {
      return res.status(400).json({ ok: false, error: 'scraplet_user_id required' });
    }

    // Upsert settings row and update fields
    const payload = {
      flood_enabled: asBool(b.flood_enabled, true),
      flood_window_seconds: asInt(b.flood_window_seconds, 10),
      flood_max_messages: asInt(b.flood_max_messages, 5),
      flood_action: String(b.flood_action || 'timeout').toLowerCase(),
      flood_duration_seconds: asInt(b.flood_duration_seconds, 30),
      flood_escalate: asBool(b.flood_escalate, true),
      flood_escalate_multiplier: asInt(b.flood_escalate_multiplier, 2),
      flood_max_duration_seconds: asInt(b.flood_max_duration_seconds, 600),
      flood_cooldown_seconds: asInt(b.flood_cooldown_seconds, 120),
    };

    const { rows } = await db.query(
      `
      INSERT INTO public.scrapbot_moderation_settings
        (scraplet_user_id, platform,
         flood_enabled, flood_window_seconds, flood_max_messages, flood_action, flood_duration_seconds,
         flood_escalate, flood_escalate_multiplier, flood_max_duration_seconds, flood_cooldown_seconds,
         updated_at)
      VALUES
        ($1,$2,
         $3,$4,$5,$6,$7,
         $8,$9,$10,$11,
         NOW())
      ON CONFLICT (scraplet_user_id)
      DO UPDATE SET
        platform = EXCLUDED.platform,
        flood_enabled = EXCLUDED.flood_enabled,
        flood_window_seconds = EXCLUDED.flood_window_seconds,
        flood_max_messages = EXCLUDED.flood_max_messages,
        flood_action = EXCLUDED.flood_action,
        flood_duration_seconds = EXCLUDED.flood_duration_seconds,
        flood_escalate = EXCLUDED.flood_escalate,
        flood_escalate_multiplier = EXCLUDED.flood_escalate_multiplier,
        flood_max_duration_seconds = EXCLUDED.flood_max_duration_seconds,
        flood_cooldown_seconds = EXCLUDED.flood_cooldown_seconds,
        updated_at = NOW()
      RETURNING *
      `,
      [
        scraplet_user_id, platform,
        payload.flood_enabled,
        payload.flood_window_seconds,
        payload.flood_max_messages,
        payload.flood_action,
        payload.flood_duration_seconds,
        payload.flood_escalate,
        payload.flood_escalate_multiplier,
        payload.flood_max_duration_seconds,
        payload.flood_cooldown_seconds,
      ]
    );

    clearSettingsCache(scraplet_user_id, platform);

    const settings = await getModerationSettings(scraplet_user_id, platform);
    return res.json({ ok: true, settings, raw: rows[0] });
  } catch (err) {
    console.error('[moderationApi] settings update error', err);
    return res.status(500).json({ ok: false, error: err.message || 'internal error' });
  }
});

// =====================================================
// ✅ Incident + Intel endpoints (low-volume, no chat logs)
// =====================================================

// GET /api/moderation/intel/hot?platform=kick&limit=25
router.get('/api/moderation/intel/hot', async (req, res) => {
  try {
    const platform = String(req.query.platform || 'kick').toLowerCase();
    const limit = Math.min(Math.max(asInt(req.query.limit, 25) || 25, 1), 100);

    const { rows } = await db.query(
      `
      SELECT signature_hash, signature_text, sample_text,
             total_hits, shield_triggers, confidence_score, hot_until, last_seen_at, tags
      FROM public.scrapbot_global_signature_intel
      WHERE platform = $1
        AND hot_until IS NOT NULL
        AND hot_until > NOW()
      ORDER BY confidence_score DESC, last_seen_at DESC
      LIMIT $2
      `,
      [platform, limit]
    );

    return res.json({ ok: true, hot: rows });
  } catch (err) {
    console.error('[moderationApi] intel hot error', err);
    return res.status(500).json({ ok: false, error: err.message || 'internal error' });
  }
});

// GET /api/moderation/incidents?scraplet_user_id=4&platform=kick&limit=20
router.get('/api/moderation/incidents', async (req, res) => {
  try {
    const scraplet_user_id = getUserIdFrom(req, asInt(req.query.scraplet_user_id));
    const platform = String(req.query.platform || 'kick').toLowerCase();
    const limit = Math.min(Math.max(asInt(req.query.limit, 20) || 20, 1), 100);

    if (!scraplet_user_id) {
      return res.status(400).json({ ok: false, error: 'scraplet_user_id required' });
    }

    const { rows } = await db.query(
      `
      SELECT *
      FROM public.scrapbot_moderation_incidents
      WHERE scraplet_user_id = $1 AND platform = $2
      ORDER BY created_at DESC
      LIMIT $3
      `,
      [scraplet_user_id, platform, limit]
    );

    return res.json({ ok: true, incidents: rows });
  } catch (err) {
    console.error('[moderationApi] incidents error', err);
    return res.status(500).json({ ok: false, error: err.message || 'internal error' });
  }
});

// GET /api/moderation/overrides?scraplet_user_id=4&platform=kick
router.get('/api/moderation/overrides', async (req, res) => {
  try {
    const scraplet_user_id = getUserIdFrom(req, asInt(req.query.scraplet_user_id));
    const platform = String(req.query.platform || 'kick').toLowerCase();

    if (!scraplet_user_id) {
      return res.status(400).json({ ok: false, error: 'scraplet_user_id required' });
    }

    const { rows } = await db.query(
      `
      SELECT id, signature_hash, mode, note, enabled, created_at
      FROM public.scrapbot_signature_overrides
      WHERE scraplet_user_id = $1 AND platform = $2
      ORDER BY created_at DESC
      `,
      [scraplet_user_id, platform]
    );

    return res.json({ ok: true, overrides: rows });
  } catch (err) {
    console.error('[moderationApi] overrides list error', err);
    return res.status(500).json({ ok: false, error: err.message || 'internal error' });
  }
});

// PUT /api/moderation/overrides
// body: { scraplet_user_id, platform, signature_hash, mode: allow|ban, note?, enabled? }
router.put('/api/moderation/overrides', async (req, res) => {
  try {
    const b = req.body || {};
    const scraplet_user_id = getUserIdFrom(req, asInt(b.scraplet_user_id));
    const platform = String(b.platform || 'kick').toLowerCase();
    const signature_hash = String(b.signature_hash || '').trim();
    const mode = String(b.mode || '').trim();
    const note = String(b.note || '').slice(0, 200);
    const enabled = b.enabled === undefined ? true : asBool(b.enabled, true);

    if (!scraplet_user_id) return res.status(400).json({ ok: false, error: 'scraplet_user_id required' });
    if (!signature_hash) return res.status(400).json({ ok: false, error: 'signature_hash required' });
    if (mode !== 'allow' && mode !== 'ban') {
      return res.status(400).json({ ok: false, error: 'mode must be allow|ban' });
    }

    const { rows } = await db.query(
      `
      INSERT INTO public.scrapbot_signature_overrides
        (scraplet_user_id, platform, signature_hash, mode, note, enabled)
      VALUES
        ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (scraplet_user_id, platform, signature_hash, mode)
      DO UPDATE SET
        note = EXCLUDED.note,
        enabled = EXCLUDED.enabled
      RETURNING id
      `,
      [scraplet_user_id, platform, signature_hash, mode, note, enabled]
    );

    return res.json({ ok: true, override: rows[0] });
  } catch (err) {
    console.error('[moderationApi] override upsert error', err);
    return res.status(500).json({ ok: false, error: err.message || 'internal error' });
  }
});



// -----------------------------
// Runtime toggles (admin only)
// -----------------------------
// These are process-local and reset on restart.
// They exist to help ops during bug-smash / live tuning.
router.get('/api/moderation/runtime', (req, res) => {
  return res.json({
    ok: true,
    runtime: {
      enforcement: String(globalThis.__scrapbot_enforcement || ''),
      usePulseTripwire: String(globalThis.__scrapbot_use_pulse_tripwire || ''),
    },
  });
});

router.post('/api/moderation/runtime', (req, res) => {
  const b = req.body || {};
  const enforcement = String(b.enforcement || '').toLowerCase().trim();
  const usePulseTripwire = b.usePulseTripwire;

  if (enforcement) {
    if (!['off','timeout_only','full'].includes(enforcement)) {
      return res.status(400).json({ ok: false, error: 'enforcement must be off|timeout_only|full' });
    }
    globalThis.__scrapbot_enforcement = enforcement;
  }

  if (usePulseTripwire !== undefined) {
    globalThis.__scrapbot_use_pulse_tripwire = String(usePulseTripwire ? '1' : '0');
  }

  return res.json({
    ok: true,
    runtime: {
      enforcement: String(globalThis.__scrapbot_enforcement || ''),
      usePulseTripwire: String(globalThis.__scrapbot_use_pulse_tripwire || ''),
    },
  });
});

// -----------------------------
// Pipeline test harness
// -----------------------------
// POST /api/moderation/pipeline_test
// Body: { scraplet_user_id, channelSlug, senderUsername, senderUserId, userRole, text, message_id?, broadcasterUserId?, platform? }
router.post('/api/moderation/pipeline_test', async (req, res) => {
  try {
    const b = req.body || {};
    const platform = String(b.platform || 'kick').toLowerCase();
    const scraplet_user_id = Number(b.scraplet_user_id || 0) || 0;
    const channelSlug = String(b.channelSlug || '').toLowerCase();
    const senderUsername = String(b.senderUsername || b.username || '').trim();
    const senderUserId = b.senderUserId != null ? String(b.senderUserId) : null;
    const userRole = String(b.userRole || 'everyone').toLowerCase();
    const text = String(b.text || '');
    const message_id = b.message_id != null ? String(b.message_id) : null;

    if (!scraplet_user_id || !channelSlug) {
      return res.status(400).json({ ok: false, error: 'missing scraplet_user_id or channelSlug' });
    }

    const pulse = channelPulseTrack({
      platform,
      scraplet_user_id,
      channelSlug,
      senderUserId,
      senderUsername,
    });

    const tripwire = pulse?.tripwire || null;

    const event = {
      platform,
      scraplet_user_id,
      channelSlug,
      senderUsername,
      senderUserId: senderUserId != null ? Number(senderUserId) : null,
      userRole,
      text,
      message_id,
      __tripwire: tripwire,
    };

    // Trust hostile check (decision only, no action)
    let trust = null;
    if (senderUserId != null && userRole !== 'mod' && userRole !== 'broadcaster') {
      const hostile = await shouldAutoHostileAction({
        platform,
        channel_id: channelSlug,
        user_id: String(senderUserId),
      });
      trust = hostile ? { matched: true, action: hostile.action, duration_seconds: hostile.duration_seconds || 0, reason: hostile.reason } : { matched: false };
    }

    const swarm = await evaluateSwarm(event);
    const flood = await evaluateFloodGuard({
      platform,
      scraplet_user_id,
      channelSlug,
      senderUsername,
      senderUserId,
      userRole,
      text,
      __tripwire: tripwire,
    });

    const rules = await evaluateModeration({
      platform,
      scraplet_user_id,
      channelSlug,
      text,
      senderUsername,
      senderUserId,
      userRole,
    });

    // Determine winner in the same order as live pipeline
    const winner =
      (trust && trust.matched) ? 'trust' :
      (swarm && swarm.matched) ? 'swarm' :
      (flood) ? 'flood' :
      (rules) ? 'rules' :
      'none';

    return res.json({
      ok: true,
      winner,
      pulse,
      tripwire,
      trust,
      swarm,
      flood,
      rules,
    });
  } catch (e) {
    console.error('[moderationApi] pipeline_test error', e);
    return res.status(500).json({ ok: false, error: e.message || 'error' });
  }
});

export default router;
