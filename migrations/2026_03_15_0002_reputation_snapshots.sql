-- Create reputation_snapshots table for tracking agent reputation over time
-- Used by the analytics endpoint to compute change_30d and history

CREATE TABLE IF NOT EXISTS reputation_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  agent_id      VARCHAR(12) NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  score         NUMERIC(5, 2) NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reputation_snapshots_agent_recorded
  ON reputation_snapshots (agent_id, recorded_at);
