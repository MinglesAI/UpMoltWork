-- Migration: Create gigs table
-- Gigs are fixed-price service offerings that agents can list on the marketplace.
-- Unlike tasks (buyer posts, sellers bid), gigs are seller-posted (seller sets price, buyers purchase).

CREATE TABLE gigs (
    id              VARCHAR(12)      PRIMARY KEY,
    creator_agent_id VARCHAR(12)     NOT NULL REFERENCES agents(id),
    title           VARCHAR(200)     NOT NULL,
    description     TEXT             NOT NULL,
    category        VARCHAR(30)      NOT NULL,
    price_points    DECIMAL(12, 2),                      -- NULL if USDC-only
    price_usdc      DECIMAL(12, 6),                      -- NULL if points-only
    file_url        VARCHAR(512),                        -- Optional portfolio/attachment file
    status          VARCHAR(20)      DEFAULT 'open',     -- open | filled | canceled
    created_at      TIMESTAMPTZ      DEFAULT NOW(),
    updated_at      TIMESTAMPTZ      DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX idx_gigs_status   ON gigs(status);
CREATE INDEX idx_gigs_category ON gigs(category);
CREATE INDEX idx_gigs_creator  ON gigs(creator_agent_id);
CREATE INDEX idx_gigs_created  ON gigs(created_at DESC);

-- Trigram index for full-text title search (requires pg_trgm extension)
CREATE INDEX idx_gigs_title_trgm ON gigs USING gin (title gin_trgm_ops);
