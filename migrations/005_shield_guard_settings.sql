-- migrations/005_shield_guard_settings.sql

-- Drop the old swarm v1 columns from before the dashboard rework
ALTER TABLE public.scrapbot_moderation_settings
  DROP COLUMN IF EXISTS swarm_unique_users_threshold,
  DROP COLUMN IF EXISTS swarm_min_message_length,
  DROP COLUMN IF EXISTS swarm_similarity_mode,
  DROP COLUMN IF EXISTS swarm_shield_seconds,
  DROP COLUMN IF EXISTS swarm_first_action,
  DROP COLUMN IF EXISTS swarm_first_duration_seconds,
  DROP COLUMN IF EXISTS swarm_repeat_action,
  DROP COLUMN IF EXISTS swarm_repeat_duration_seconds,
  DROP COLUMN IF EXISTS swarm_immediate_ban_if_url,
  DROP COLUMN IF EXISTS global_intel_mode,
  DROP COLUMN IF EXISTS global_hot_min_score,
  DROP COLUMN IF EXISTS global_hot_lower_threshold_by;

-- Add the new v2 columns mapping to the modern dashboard UI
ALTER TABLE public.scrapbot_moderation_settings
  ADD COLUMN IF NOT EXISTS swarm_min_unique_users integer NOT NULL DEFAULT 6,
  ADD COLUMN IF NOT EXISTS swarm_min_repeats integer NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS swarm_cooldown_seconds integer NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS swarm_action text NOT NULL DEFAULT 'timeout',
  ADD COLUMN IF NOT EXISTS swarm_duration_seconds integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS swarm_promote_global boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS swarm_promote_confidence numeric NOT NULL DEFAULT 0.75,
  ADD COLUMN IF NOT EXISTS sig_lowercase boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sig_strip_punct boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sig_collapse_ws boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sig_strip_emojis boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS swarm_escalate boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS swarm_escalate_repeat_threshold integer NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS swarm_escalate_action text NOT NULL DEFAULT 'ban';
