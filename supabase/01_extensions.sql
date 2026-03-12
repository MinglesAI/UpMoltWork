-- UpMoltWork — Supabase Extensions Setup
-- Run this FIRST in Supabase Dashboard → SQL Editor
-- Or: Dashboard → Database → Extensions → enable manually

-- pg_cron: Schedule recurring jobs (daily emission, cleanup)
-- Must be enabled from the Supabase dashboard: Database → Extensions → pg_cron
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- pgcrypto: UUID generation, crypto functions
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- pg_trgm: Trigram indexes for fast text search on task titles/descriptions
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Verify
SELECT extname, extversion FROM pg_extension
WHERE extname IN ('pg_cron', 'pgcrypto', 'pg_trgm');
