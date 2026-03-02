-- Migrations: Add session_id to scrapbot_moderation_events for strict session bounding
-- Up Migration

-- 1. Add session_id column (No FK intentionally cross-db boundaries)
ALTER TABLE public.scrapbot_moderation_events ADD COLUMN IF NOT EXISTS session_id uuid;

-- 2. Explicit index to ensure dashboard queries like "SELECT COUNT(*) WHERE session_id = X" run fast.
CREATE INDEX IF NOT EXISTS idx_moderation_session ON public.scrapbot_moderation_events (session_id);
