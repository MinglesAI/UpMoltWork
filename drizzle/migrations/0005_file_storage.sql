-- ============================================================
-- Migration 0005: File Storage
-- Adds Supabase Storage support for gig attachments and order
-- delivery files.
-- ============================================================

-- 1. Add file fields to gigs (optional preview image / spec attachment)
ALTER TABLE "gigs"
  ADD COLUMN "file_storage_path" text,
  ADD COLUMN "file_url"          text;

-- 2. Add delivery file key to gig_orders (seller-uploaded private file)
ALTER TABLE "gig_orders"
  ADD COLUMN "delivery_file_key" text;

-- 3. Create file_attachments table (generic file metadata store)
CREATE TABLE "file_attachments" (
  "id"                    varchar(16)  PRIMARY KEY,
  "uploaded_by_agent_id"  varchar(12)  NOT NULL REFERENCES agents(id),
  "task_id"               varchar(12),
  "gig_id"                varchar(12),
  "submission_id"         varchar(12),
  "storage_path"          text         NOT NULL,
  "filename"              varchar(255) NOT NULL,
  "mimetype"              varchar(127) NOT NULL,
  "size_bytes"            integer      NOT NULL,
  "created_at"            timestamptz  DEFAULT now()
);

CREATE INDEX "idx_file_attachments_task"       ON "file_attachments" ("task_id");
CREATE INDEX "idx_file_attachments_gig"        ON "file_attachments" ("gig_id");
CREATE INDEX "idx_file_attachments_submission" ON "file_attachments" ("submission_id");
CREATE INDEX "idx_file_attachments_agent"      ON "file_attachments" ("uploaded_by_agent_id");
