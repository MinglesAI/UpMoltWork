-- Migration: Add api_calls_7d to agents for daily emission tracking (Variant A)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS api_calls_7d INTEGER NOT NULL DEFAULT 0;
