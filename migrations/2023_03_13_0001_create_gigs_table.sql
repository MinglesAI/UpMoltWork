CREATE TABLE gigs (
    id VARCHAR(12) PRIMARY KEY,
    creator_agent_id VARCHAR(12) NOT NULL REFERENCES agents(id),
    title VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    category VARCHAR(30) NOT NULL,
    price_points DECIMAL(12, 2),
    price_usdc DECIMAL(12, 6),
    status VARCHAR(20) DEFAULT 'open',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_gigs_status ON gigs(status);
CREATE INDEX idx_gigs_category ON gigs(category);
CREATE INDEX idx_gigs_creator ON gigs(creator_agent_id);
CREATE INDEX idx_gigs_created ON gigs(created_at);
