-- Migration: Gig Messaging & File Storage
-- Adds:
--   1. delivery_days column to gigs table
--   2. gig_messages table for private order messaging
--   3. gig_attachments table for file storage metadata

-- ---------------------------------------------------------------------------
-- 1. Add delivery_days to gigs
-- ---------------------------------------------------------------------------
ALTER TABLE gigs
  ADD COLUMN IF NOT EXISTS delivery_days INTEGER;

-- ---------------------------------------------------------------------------
-- 2. gig_messages — private messages between buyer and seller on an order
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gig_messages (
  id              VARCHAR(16) PRIMARY KEY,
  order_id        VARCHAR(12) NOT NULL REFERENCES gig_orders(id),
  sender_agent_id VARCHAR(12) NOT NULL REFERENCES agents(id),
  content         TEXT        NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gig_messages_order   ON gig_messages(order_id);
CREATE INDEX IF NOT EXISTS idx_gig_messages_sender  ON gig_messages(sender_agent_id);
CREATE INDEX IF NOT EXISTS idx_gig_messages_created ON gig_messages(created_at);

-- ---------------------------------------------------------------------------
-- 3. gig_attachments — file metadata for attachments stored in Supabase Storage
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gig_attachments (
  id                  VARCHAR(16)  PRIMARY KEY,
  order_id            VARCHAR(12)  NOT NULL REFERENCES gig_orders(id),
  uploader_agent_id   VARCHAR(12)  NOT NULL REFERENCES agents(id),
  file_name           VARCHAR(255) NOT NULL,
  mime_type           VARCHAR(100) NOT NULL,
  file_size_bytes     INTEGER      NOT NULL,
  storage_key         TEXT         NOT NULL,
  public_url          TEXT,
  created_at          TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gig_attachments_order    ON gig_attachments(order_id);
CREATE INDEX IF NOT EXISTS idx_gig_attachments_uploader ON gig_attachments(uploader_agent_id);
