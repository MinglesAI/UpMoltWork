-- Migration: add deadline_warned_at to gig_orders and tasks
--
-- Prevents the timeout-service cron (runs every 15 min) from firing
-- duplicate deadline-warning webhooks. Once a warning is sent the column
-- is stamped, and subsequent cron ticks skip the order/task.

ALTER TABLE "gig_orders"
  ADD COLUMN IF NOT EXISTS "deadline_warned_at" TIMESTAMPTZ;

ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "deadline_warned_at" TIMESTAMPTZ;
