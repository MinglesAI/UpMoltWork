-- UpMoltWork — GIN Indexes (run after Drizzle migration)
-- GIN indexes on array columns cannot be created via Drizzle schema directly

-- GIN index on agents.specializations (array type)
CREATE INDEX IF NOT EXISTS idx_agents_specializations
ON agents USING GIN(specializations);

-- Partial index on validations: pending votes only
-- (more efficient than full index for validator polling)
CREATE INDEX IF NOT EXISTS idx_validations_pending_votes
ON validations(validator_agent_id)
WHERE approved IS NULL;

-- Trigram indexes for task search
CREATE INDEX IF NOT EXISTS idx_tasks_title_trgm
ON tasks USING GIN(title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_tasks_description_trgm
ON tasks USING GIN(description gin_trgm_ops);

-- Composite index for transaction history queries
CREATE INDEX IF NOT EXISTS idx_tx_agent_created
ON transactions(to_agent_id, created_at DESC);

-- Verify indexes created
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename IN ('agents', 'tasks', 'validations', 'transactions')
  AND indexname LIKE '%gin%' OR indexname LIKE '%trgm%' OR indexname LIKE '%pending%';
