-- Migration: 0001_file_storage
-- Adds tables and columns needed for Supabase Storage file attachments.
--
-- Apply via:  psql $DATABASE_URL -f migrations/0001_file_storage.sql
-- Or via:     npm run db:migrate  (if using drizzle-kit migrate)

-- ---------------------------------------------------------------------------
-- 1. Add optional file columns to gigs (e.g. a spec PDF or preview image)
-- ---------------------------------------------------------------------------
ALTER TABLE gigs
  ADD COLUMN IF NOT EXISTS file_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS file_url          TEXT;

-- ---------------------------------------------------------------------------
-- 2. Add optional file column to gig_orders (seller deliverable file)
-- ---------------------------------------------------------------------------
ALTER TABLE gig_orders
  ADD COLUMN IF NOT EXISTS delivery_file_key TEXT;

-- ---------------------------------------------------------------------------
-- 3. file_attachments — metadata for all uploaded files
--
--    One row per uploaded file.  Exactly one of task_id / gig_id / submission_id
--    should be set to link the file to its parent entity.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS file_attachments (
  id                   VARCHAR(16) PRIMARY KEY,
  uploaded_by_agent_id VARCHAR(12) NOT NULL REFERENCES agents(id),

  -- Parent entity (at most one should be non-null)
  task_id              VARCHAR(12),
  gig_id               VARCHAR(12),
  submission_id        VARCHAR(12),

  -- Supabase Storage details
  storage_path         TEXT        NOT NULL,
  filename             VARCHAR(255) NOT NULL,
  mimetype             VARCHAR(127) NOT NULL,
  size_bytes           INTEGER      NOT NULL,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common lookups
CREATE INDEX IF NOT EXISTS idx_file_attachments_task       ON file_attachments(task_id);
CREATE INDEX IF NOT EXISTS idx_file_attachments_gig        ON file_attachments(gig_id);
CREATE INDEX IF NOT EXISTS idx_file_attachments_submission ON file_attachments(submission_id);
CREATE INDEX IF NOT EXISTS idx_file_attachments_agent      ON file_attachments(uploaded_by_agent_id);

-- ---------------------------------------------------------------------------
-- 4. Supabase Storage bucket (run once in Supabase dashboard or via API)
-- ---------------------------------------------------------------------------
-- The bucket "gig-attachments" must be created in Supabase Storage with:
--   - private access (no public reads)
--   - max file size: 50 MB
--   - allowed MIME types: image/*, application/pdf, text/plain, text/markdown,
--                         application/zip, application/json, video/mp4,
--                         video/webm, audio/mpeg, audio/wav
--
-- This cannot be done via SQL — use the Supabase dashboard:
--   Storage → New bucket → Name: gig-attachments → Private
-- Or via the Management API:
--   POST https://<project>.supabase.co/storage/v1/bucket
--   { "name": "gig-attachments", "public": false, "file_size_limit": 52428800 }
