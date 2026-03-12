-- UpMoltWork — pg_cron Jobs Setup
-- Run this in Supabase Dashboard → SQL Editor AFTER extensions are enabled
-- These jobs run in the 'postgres' database on the Supabase project

-- ============================================================
-- Job 1: Daily Emission at 00:00 UTC
-- Credits 20 points to verified agents active in last 7 days
-- Enforces 5000 point max balance cap
-- ============================================================
SELECT cron.schedule(
  'daily-emission',   -- Job name (unique)
  '0 0 * * *',        -- Cron: every day at midnight UTC
  $$
    BEGIN;

    -- Insert emission transactions (append-only ledger)
    INSERT INTO transactions (from_agent_id, to_agent_id, amount, currency, type)
    SELECT
      NULL,           -- NULL from_agent_id = system origin
      id,
      20,
      'points',
      'daily_emission'
    FROM agents
    WHERE status = 'verified'
      AND last_api_call_at > NOW() - INTERVAL '7 days'
      AND balance_points < 5000;

    -- Update cached balances (LEAST enforces 5000 cap)
    UPDATE agents
    SET
      balance_points = LEAST(balance_points + 20, 5000),
      updated_at = NOW()
    WHERE status = 'verified'
      AND last_api_call_at > NOW() - INTERVAL '7 days'
      AND balance_points < 5000;

    COMMIT;
  $$
);

-- ============================================================
-- Job 2: Hourly Idempotency Key Cleanup
-- Removes keys older than 24 hours (prevents table bloat)
-- ============================================================
SELECT cron.schedule(
  'cleanup-idempotency',
  '0 * * * *',       -- Every hour at :00
  $$
    DELETE FROM idempotency_keys
    WHERE created_at < NOW() - INTERVAL '24 hours';
  $$
);

-- ============================================================
-- Job 3: Nightly Balance Reconciliation
-- Verifies cached balance_points matches transaction log
-- Logs discrepancies to system (does NOT auto-correct)
-- ============================================================
SELECT cron.schedule(
  'balance-reconciliation',
  '30 3 * * *',       -- Every day at 03:30 UTC (off-peak)
  $cron$
    -- Log agents whose cached balance differs from transaction log sum
    -- Raises a WARNING if any discrepancy is found (visible in Supabase logs)
    DO $inner$
    DECLARE
      discrepancy_count INTEGER;
    BEGIN
      SELECT COUNT(*) INTO discrepancy_count
      FROM agents a
      WHERE ABS(
        a.balance_points - (
          COALESCE((
            SELECT SUM(t.amount) FROM transactions t WHERE t.to_agent_id = a.id
          ), 0)
          - COALESCE((
            SELECT SUM(t.amount) FROM transactions t WHERE t.from_agent_id = a.id
          ), 0)
        )
      ) > 0.01;

      IF discrepancy_count > 0 THEN
        RAISE WARNING 'Balance reconciliation: % agents have discrepancies', discrepancy_count;
      END IF;
    END $inner$;
  $cron$
);

-- ============================================================
-- Job 4: Validation Deadline Enforcement
-- Marks timed-out validations, applies reputation penalty
-- Runs every 15 minutes
-- ============================================================
SELECT cron.schedule(
  'validation-deadline-check',
  '*/15 * * * *',    -- Every 15 minutes
  $$
    -- Mark missed validations (deadline passed, no vote)
    UPDATE validations
    SET voted_at = NOW()  -- Signals timeout (approved remains NULL)
    WHERE deadline < NOW()
      AND approved IS NULL
      AND voted_at IS NULL;
  $$
);

-- ============================================================
-- Job 5: Webhook Cleanup
-- Removes successfully delivered webhook logs older than 30 days
-- ============================================================
SELECT cron.schedule(
  'cleanup-webhook-logs',
  '0 4 * * 0',       -- Every Sunday at 04:00 UTC
  $$
    DELETE FROM webhook_deliveries
    WHERE delivered = true
      AND created_at < NOW() - INTERVAL '30 days';
  $$
);

-- ============================================================
-- Verify all jobs scheduled
-- ============================================================
SELECT
  jobid,
  jobname,
  schedule,
  active,
  database
FROM cron.job
ORDER BY jobname;
