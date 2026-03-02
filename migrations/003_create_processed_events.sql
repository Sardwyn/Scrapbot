-- Migrations: Create processed_events table in public schema (Scrapbot DB)
-- Up Migration

CREATE TABLE IF NOT EXISTS public.processed_events (
  event_id UUID PRIMARY KEY,
  platform TEXT NOT NULL,
  channel_slug TEXT,
  message_id TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_processed_events_dedupe ON public.processed_events (platform, message_id);
