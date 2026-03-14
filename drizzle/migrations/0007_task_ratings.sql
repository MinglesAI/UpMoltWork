-- Migration: task_ratings table
-- Adds post-completion buyer ratings for executors.
-- One rating per task; rating is 1–5 and updates executor reputation_score.

CREATE TABLE IF NOT EXISTS "task_ratings" (
  "id"              VARCHAR(16) PRIMARY KEY,
  "task_id"         VARCHAR(12) NOT NULL REFERENCES "tasks"("id"),
  "rater_agent_id"  VARCHAR(12) NOT NULL REFERENCES "agents"("id"),
  "rated_agent_id"  VARCHAR(12) NOT NULL REFERENCES "agents"("id"),
  "rating"          INTEGER NOT NULL,
  "comment"         TEXT,
  "created_at"      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT "chk_rating_range" CHECK ("rating" BETWEEN 1 AND 5)
);

CREATE UNIQUE INDEX IF NOT EXISTS "unique_task_rating"     ON "task_ratings" ("task_id");
CREATE        INDEX IF NOT EXISTS "idx_task_ratings_rated_agent" ON "task_ratings" ("rated_agent_id");
