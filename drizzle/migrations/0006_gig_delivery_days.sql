-- Migration: Add delivery_days to gigs table
-- Part of issue #40: Gig feature — delivery timelines

ALTER TABLE gigs
  ADD COLUMN IF NOT EXISTS delivery_days INTEGER;

COMMENT ON COLUMN gigs.delivery_days IS 'Estimated delivery time in calendar days (1-90). NULL means no stated timeline.';
