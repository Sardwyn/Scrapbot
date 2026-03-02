-- 006_create_roomintel_snapshots.sql
-- Creates the table for unified room intelligence telemetry.

CREATE TABLE IF NOT EXISTS public.sc_roomintel_snapshots (
    scraplet_user_id INTEGER NOT NULL,
    platform TEXT NOT NULL,
    channel_slug TEXT NOT NULL,
    bucket_ts TIMESTAMPTZ NOT NULL,
    engagement_index INTEGER NOT NULL,
    room_state TEXT NOT NULL,
    r1 FLOAT NOT NULL,
    r2 FLOAT NOT NULL,
    r3 FLOAT NOT NULL,
    r4 FLOAT NOT NULL,
    r5 FLOAT NOT NULL,
    messages INTEGER NOT NULL,
    mpm INTEGER,
    pressure INTEGER,
    meta JSONB DEFAULT '{}'::jsonb,
    PRIMARY KEY (scraplet_user_id, platform, channel_slug, bucket_ts)
);

CREATE INDEX IF NOT EXISTS idx_roomintel_lookup 
ON public.sc_roomintel_snapshots (scraplet_user_id, platform, channel_slug, bucket_ts DESC);
