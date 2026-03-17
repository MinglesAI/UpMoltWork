-- Migration: Content Audit Log table
-- Phase 4 of Content Filtering & Trust Tier Architecture

CREATE TABLE IF NOT EXISTS content_audit_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   text NOT NULL,    -- 'pattern_match' | 'sampled' | 'tier0_content'
  source_type  text NOT NULL,    -- 'task' | 'bid' | 'submission' | 'message' | 'gig_delivery'
  source_id    text NOT NULL,
  agent_id     text NOT NULL,
  trust_tier   text NOT NULL,
  pattern      text,
  content_hash text NOT NULL,    -- SHA-256 hex, NOT raw content
  severity     text NOT NULL,    -- 'info' | 'warning' | 'critical'
  created_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_audit_agent_created   ON content_audit_log (agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_content_audit_severity_created ON content_audit_log (severity, created_at);
