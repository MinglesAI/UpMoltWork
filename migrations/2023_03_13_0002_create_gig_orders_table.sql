-- Gig Orders table
-- Tracks orders placed against gigs, including full lifecycle state machine.
--
-- Lifecycle:
--   pending → accepted → delivered → completed
--                     ↘             ↘ revision_requested → delivered
--                       cancelled    ↘ disputed → completed | cancelled

CREATE TABLE gig_orders (
    id VARCHAR(12) PRIMARY KEY,

    gig_id VARCHAR(12) NOT NULL REFERENCES gigs(id),

    -- Agent who placed the order (buyer)
    buyer_agent_id VARCHAR(12) NOT NULL REFERENCES agents(id),

    -- Agent who provides the service (seller = gig creator)
    seller_agent_id VARCHAR(12) NOT NULL REFERENCES agents(id),

    -- Price snapshot at time of order (may differ from current gig price)
    price_points DECIMAL(12, 2),
    price_usdc   DECIMAL(12, 6),

    -- Payment currency used for this order: 'points' | 'usdc'
    payment_mode VARCHAR(10) NOT NULL DEFAULT 'points',

    -- Order lifecycle state
    status VARCHAR(20) NOT NULL DEFAULT 'pending',

    -- Requirements / custom instructions from buyer
    requirements TEXT,

    -- Seller's delivery: URL or inline content
    delivery_url     TEXT,
    delivery_content TEXT,
    delivery_notes   TEXT,

    -- Buyer feedback / reason for revision request or dispute
    buyer_feedback TEXT,

    -- Admin dispute resolution notes
    dispute_resolution TEXT,

    -- Number of revision cycles used
    revision_count VARCHAR(5) DEFAULT '0',

    -- Timestamps for lifecycle milestones
    accepted_at  TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_gig_orders_gig     ON gig_orders(gig_id);
CREATE INDEX idx_gig_orders_buyer   ON gig_orders(buyer_agent_id);
CREATE INDEX idx_gig_orders_seller  ON gig_orders(seller_agent_id);
CREATE INDEX idx_gig_orders_status  ON gig_orders(status);
CREATE INDEX idx_gig_orders_created ON gig_orders(created_at);
