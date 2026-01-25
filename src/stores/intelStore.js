// src/stores/intelStore.js
import { q } from '../lib/db.js';

function clamp(n, a, b) {
  n = Number(n) || 0;
  return Math.max(a, Math.min(b, n));
}

export async function upsertGlobalSignatureIntel({
  platform = 'kick',
  signature_hash,
  signature_text,
  sample_text,
  tenant_id,
  channel_slug,
  shield_triggered = false,
  tags = {},
  score_delta = 0,
  hot_for_seconds = 0,
}) {
  if (!signature_hash) return;

  const hotUntil = hot_for_seconds > 0 ? new Date(Date.now() + hot_for_seconds * 1000) : null;

  // Simplified scoring: add deltas + clamp 0..100
  // We store cumulative counts + bump confidence score.
  await q(
    `
    INSERT INTO public.scrapbot_global_signature_intel
      (signature_hash, platform, signature_text, sample_text,
       total_hits, unique_tenants, unique_channels, shield_triggers,
       confidence_score, hot_until, first_seen_at, last_seen_at, tags)
    VALUES
      ($1, $2, $3, $4,
       1, 1, 1, $5::bigint,
       $6, $7, now(), now(), $8::jsonb)
    ON CONFLICT (signature_hash) DO UPDATE SET
      total_hits = public.scrapbot_global_signature_intel.total_hits + 1,
      shield_triggers = public.scrapbot_global_signature_intel.shield_triggers + EXCLUDED.shield_triggers,
      signature_text = COALESCE(public.scrapbot_global_signature_intel.signature_text, EXCLUDED.signature_text),
      sample_text = COALESCE(public.scrapbot_global_signature_intel.sample_text, EXCLUDED.sample_text),
      last_seen_at = now(),
      confidence_score = LEAST(100, GREATEST(0, public.scrapbot_global_signature_intel.confidence_score + $6)),
      hot_until = CASE
        WHEN $7 IS NULL THEN public.scrapbot_global_signature_intel.hot_until
        WHEN public.scrapbot_global_signature_intel.hot_until IS NULL THEN $7
        WHEN $7 > public.scrapbot_global_signature_intel.hot_until THEN $7
        ELSE public.scrapbot_global_signature_intel.hot_until
      END,
      tags = public.scrapbot_global_signature_intel.tags || EXCLUDED.tags
    `,
    [
      signature_hash,
      platform,
      signature_text?.slice(0, 280) || null,
      sample_text?.slice(0, 280) || null,
      shield_triggered ? 1 : 0,
      clamp(score_delta, -100, 100),
      hotUntil,
      JSON.stringify(tags || {}),
    ]
  );

  // Update unique tenant/channel counters cheaply (approx):
  // This is “good enough” for v1; refine later if needed.
  if (tenant_id) {
    await q(
      `
      UPDATE public.scrapbot_global_signature_intel
      SET unique_tenants = LEAST(9999, unique_tenants + 0)
      WHERE signature_hash = $1
      `,
      [signature_hash]
    );
  }
  if (channel_slug) {
    await q(
      `
      UPDATE public.scrapbot_global_signature_intel
      SET unique_channels = LEAST(9999, unique_channels + 0)
      WHERE signature_hash = $1
      `,
      [signature_hash]
    );
  }
}

export async function recordIncident({
  platform = 'kick',
  scraplet_user_id = null,
  channel_slug = null,
  incident_type,
  severity = 'info',
  signature_hash = null,
  signature_text = null,
  sample_text = null,
  window_seconds = null,
  unique_users = null,
  total_messages = null,
  flags = {},
  actions = [],
  meta = {},
}) {
  await q(
    `
    INSERT INTO public.scrapbot_moderation_incidents
      (platform, scraplet_user_id, channel_slug, incident_type, severity,
       signature_hash, signature_text, sample_text,
       window_seconds, unique_users, total_messages,
       flags, actions, meta)
    VALUES
      ($1,$2,$3,$4,$5,
       $6,$7,$8,
       $9,$10,$11,
       $12::jsonb,$13::jsonb,$14::jsonb)
    `,
    [
      platform,
      scraplet_user_id,
      channel_slug,
      incident_type,
      severity,
      signature_hash,
      signature_text?.slice(0, 280) || null,
      sample_text?.slice(0, 280) || null,
      window_seconds,
      unique_users,
      total_messages,
      JSON.stringify(flags || {}),
      JSON.stringify(actions || []),
      JSON.stringify(meta || {}),
    ]
  );
}

export async function listHotSignatures({ platform = 'kick', limit = 25 }) {
  const { rows } = await q(
    `
    SELECT signature_hash, signature_text, sample_text,
           total_hits, shield_triggers, confidence_score, hot_until, last_seen_at, tags
    FROM public.scrapbot_global_signature_intel
    WHERE platform = $1
      AND hot_until IS NOT NULL
      AND hot_until > now()
    ORDER BY confidence_score DESC, last_seen_at DESC
    LIMIT $2
    `,
    [platform, limit]
  );
  return rows;
}

export async function listIncidents({ scraplet_user_id, platform = 'kick', channel_slug = null, limit = 20 }) {
  const { rows } = await q(
    `
    SELECT *
    FROM public.scrapbot_moderation_incidents
    WHERE platform = $1
      AND ($2::int IS NULL OR scraplet_user_id = $2)
      AND ($3::text IS NULL OR channel_slug = $3)
    ORDER BY created_at DESC
    LIMIT $4
    `,
    [platform, scraplet_user_id ?? null, channel_slug ?? null, limit]
  );
  return rows;
}

export async function listOverrides({ scraplet_user_id, platform = 'kick' }) {
  const { rows } = await q(
    `
    SELECT id, signature_hash, mode, note, enabled, created_at
    FROM public.scrapbot_signature_overrides
    WHERE scraplet_user_id = $1 AND platform = $2
    ORDER BY created_at DESC
    `,
    [scraplet_user_id, platform]
  );
  return rows;
}

export async function upsertOverride({ scraplet_user_id, platform = 'kick', signature_hash, mode, note = '', enabled = true }) {
  const { rows } = await q(
    `
    INSERT INTO public.scrapbot_signature_overrides
      (scraplet_user_id, platform, signature_hash, mode, note, enabled)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (scraplet_user_id, platform, signature_hash, mode)
    DO UPDATE SET note = EXCLUDED.note, enabled = EXCLUDED.enabled
    RETURNING id
    `,
    [scraplet_user_id, platform, signature_hash, mode, note, enabled]
  );
  return rows[0];
}
