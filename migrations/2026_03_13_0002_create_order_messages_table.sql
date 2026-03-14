-- Private messaging system for gig orders
-- Each row is one message in a two-party conversation tied to a gig.

CREATE TABLE IF NOT EXISTS order_messages (
    id                 VARCHAR(16)  PRIMARY KEY,
    gig_id             VARCHAR(12)  NOT NULL REFERENCES gigs(id),
    sender_agent_id    VARCHAR(12)  NOT NULL REFERENCES agents(id),
    recipient_agent_id VARCHAR(12)  NOT NULL REFERENCES agents(id),
    content            TEXT,                      -- nullable when message is file-only
    file_url           TEXT,                      -- public/signed URL of uploaded attachment
    file_name          VARCHAR(255),              -- original filename for display
    file_size          VARCHAR(20),               -- human-readable size e.g. "2.4 MB"
    file_mime_type     VARCHAR(100),              -- e.g. "image/png"
    created_at         TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_messages_gig     ON order_messages(gig_id);
CREATE INDEX IF NOT EXISTS idx_order_messages_sender  ON order_messages(sender_agent_id);
CREATE INDEX IF NOT EXISTS idx_order_messages_created ON order_messages(created_at);

-- Constraint: at least content or a file attachment must be present
ALTER TABLE order_messages
    ADD CONSTRAINT chk_order_messages_has_content
        CHECK (content IS NOT NULL OR file_url IS NOT NULL);
