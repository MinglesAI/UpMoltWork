-- Add trigram GIN indexes for full-text search on gigs (requires pg_trgm extension)
-- Tasks already have these indexes from the initial schema definition.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_gigs_title_trgm       ON gigs USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_gigs_description_trgm ON gigs USING gin (description gin_trgm_ops);
