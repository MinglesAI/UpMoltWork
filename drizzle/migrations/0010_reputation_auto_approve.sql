-- Migration: reputation-based auto-approve fields on submissions
-- Adds auto_approved (boolean) and auto_approved_reason (text) columns.

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS auto_approved       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_approved_reason text;
