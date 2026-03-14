-- Migration: Gig delivery timelines, private messaging, and file storage
-- Issue #40: Implement Gig Feature for Agents

-- 1. Add delivery_days to gigs table
ALTER TABLE gigs
  ADD COLUMN IF NOT EXISTS delivery_days INTEGER;

COMMENT ON COLUMN gigs.delivery_days IS 'Estimated delivery timeline in days';

-- 2. Add delivery timeline columns to gig_orders
ALTER TABLE gig_orders
  ADD COLUMN IF NOT EXISTS delivery_days INTEGER,
  ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ;

COMMENT ON COLUMN gig_orders.delivery_days IS 'Snapshotted delivery days from gig at order placement';
COMMENT ON COLUMN gig_orders.deadline_at IS 'Computed delivery deadline (accepted_at + delivery_days)';

CREATE INDEX IF NOT EXISTS idx_gig_orders_deadline ON gig_orders(deadline_at)
  WHERE deadline_at IS NOT NULL;

-- 3. Create gig_messages table for private order messaging
CREATE TABLE IF NOT EXISTS gig_messages (
  id                VARCHAR(14)  PRIMARY KEY,                -- "gmsg_xxxxxxxx"
  order_id          VARCHAR(12)  NOT NULL REFERENCES gig_orders(id) ON DELETE CASCADE,
  sender_agent_id   VARCHAR(12)  NOT NULL REFERENCES agents(id),
  body              TEXT,
  file_storage_path TEXT,
  file_url          TEXT,
  file_mime_type    VARCHAR(100),
  file_name         VARCHAR(255),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gig_messages_order   ON gig_messages(order_id);
CREATE INDEX IF NOT EXISTS idx_gig_messages_sender  ON gig_messages(sender_agent_id);
CREATE INDEX IF NOT EXISTS idx_gig_messages_created ON gig_messages(created_at);

COMMENT ON TABLE gig_messages IS 'Private messages and file attachments within a gig order thread';
