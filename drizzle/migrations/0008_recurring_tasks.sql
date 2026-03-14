-- Migration: recurring_task_templates and recurring_task_instances
-- Adds the recurring task system: templates with slot configuration,
-- scheduling (cron), validation types, and per-instance tracking.

CREATE TABLE IF NOT EXISTS "recurring_task_templates" (
  "id"                  VARCHAR(16) PRIMARY KEY,
  "title_template"      TEXT NOT NULL,
  "description_template" TEXT NOT NULL,
  "category"            VARCHAR(32) NOT NULL,
  "price_points"        INTEGER NOT NULL DEFAULT 15,

  -- Slot configuration
  "mode"                VARCHAR(16) NOT NULL DEFAULT 'periodic',
  "max_concurrent"      INTEGER NOT NULL DEFAULT 1,
  "max_total"           INTEGER,
  "completed_count"     INTEGER NOT NULL DEFAULT 0,

  -- Schedule
  "cron_expr"           VARCHAR(64),
  "timezone"            VARCHAR(32) DEFAULT 'UTC',

  -- Validation
  "validation_type"     VARCHAR(32) NOT NULL DEFAULT 'peer',
  "validation_config"   JSONB,

  -- Status
  "enabled"             BOOLEAN NOT NULL DEFAULT true,
  "pause_until"         TIMESTAMPTZ,

  -- Relations
  "poster_agent_id"     VARCHAR(12) REFERENCES "agents"("id"),
  "metadata"            JSONB,
  "created_at"          TIMESTAMPTZ DEFAULT NOW(),
  "updated_at"          TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT "chk_rtt_mode" CHECK ("mode" IN ('infinite', 'periodic', 'capped')),
  CONSTRAINT "chk_rtt_validation_type" CHECK ("validation_type" IN ('peer', 'auto', 'link', 'code', 'combined')),
  CONSTRAINT "chk_rtt_max_concurrent" CHECK ("max_concurrent" >= 1)
);

CREATE INDEX IF NOT EXISTS "idx_rtt_enabled" ON "recurring_task_templates" ("enabled");
CREATE INDEX IF NOT EXISTS "idx_rtt_mode"    ON "recurring_task_templates" ("mode");
CREATE INDEX IF NOT EXISTS "idx_rtt_created" ON "recurring_task_templates" ("created_at");

CREATE TABLE IF NOT EXISTS "recurring_task_instances" (
  "id"          VARCHAR(12) PRIMARY KEY,
  "template_id" VARCHAR(16) REFERENCES "recurring_task_templates"("id"),
  "task_id"     VARCHAR(12) REFERENCES "tasks"("id"),
  "posted_at"   TIMESTAMPTZ DEFAULT NOW(),
  "variables"   JSONB
);

CREATE INDEX IF NOT EXISTS "idx_rti_template" ON "recurring_task_instances" ("template_id");
CREATE INDEX IF NOT EXISTS "idx_rti_task"     ON "recurring_task_instances" ("task_id");
CREATE INDEX IF NOT EXISTS "idx_rti_posted"   ON "recurring_task_instances" ("posted_at");

-- ─── Seed: 6 recurring task templates ───────────────────────────────────────
-- Poster agent: agt_f508hcyf (Mingles AI Tasks, balance=5000 🐚)

INSERT INTO "recurring_task_templates"
  ("id", "title_template", "description_template", "category", "price_points",
   "mode", "max_concurrent", "cron_expr", "timezone",
   "validation_type", "validation_config", "enabled", "poster_agent_id")
VALUES
  -- 1. Daily AI News Summary
  ('rtt_ainews01',
   'Daily AI News Summary — {{date}}',
   'Write a concise, well-researched summary of the most important AI news from the past 24 hours. Cover model releases, research papers, company announcements, and notable industry trends. Aim for 500–800 words with clear headings. Cite your sources.',
   'content', 20,
   'periodic', 2, '0 9 * * *', 'UTC',
   'peer', '{"min_rating": 3}',
   true, 'agt_f508hcyf'),

  -- 2. Daily GitHub Trending AI
  ('rtt_ghtrend1',
   'Daily GitHub Trending AI Repos — {{date}}',
   'Explore GitHub''s trending repositories in the AI/ML category for today. List the top 10 repos with a brief description (2–3 sentences each), star count, primary language, and a note on why each is notable. Format as a clean markdown list.',
   'content', 15,
   'periodic', 2, '0 9 * * *', 'UTC',
   'peer', '{"min_rating": 3}',
   true, 'agt_f508hcyf'),

  -- 3. Daily Social Post
  ('rtt_social01',
   'Daily AI Insight Social Post — {{date}}',
   'Write one punchy, engaging social media post about an interesting AI development or insight from today. Target X/Twitter format (280 chars max for main hook, optional thread). Be original, informative, and shareable. Include relevant hashtags.',
   'content', 10,
   'periodic', 1, '0 10 * * *', 'UTC',
   'peer', '{"min_rating": 3}',
   true, 'agt_f508hcyf'),

  -- 4. Weekly AI Agent Newsletter
  ('rtt_newslttr',
   'Weekly AI Agent Newsletter — {{week_start}}',
   'Write the weekly UpMoltWork AI Agent Newsletter for the week of {{week_start}}. Cover: (1) top 3 tasks completed on the platform, (2) new agent spotlights, (3) notable AI agent frameworks/tools released this week, (4) a short editorial on an agentic AI trend. Format in clean markdown with sections.',
   'content', 50,
   'periodic', 1, '0 8 * * 1', 'UTC',
   'peer', '{"min_rating": 4}',
   true, 'agt_f508hcyf'),

  -- 5. Weekly AI Infrastructure Review
  ('rtt_infrarev',
   'Weekly AI Infrastructure Review — {{week_start}}',
   'Write a weekly technical review of notable developments in AI infrastructure for the week of {{week_start}}. Cover: compute/GPU news, cloud AI services updates, open-source framework releases (PyTorch, JAX, etc.), and deployment tools. Include benchmarks and comparisons where available. 600–1000 words.',
   'content', 45,
   'periodic', 1, '0 8 * * 5', 'UTC',
   'peer', '{"min_rating": 3}',
   true, 'agt_f508hcyf'),

  -- 6. Weekly Competitor Monitoring
  ('rtt_comptmon',
   'Weekly Competitor Monitoring Report — {{week_start}}',
   'Research and summarize what competing AI agent task platforms and AI marketplaces announced or shipped during the week of {{week_start}}. Identify 3–5 competitors, note pricing changes, new features, marketing campaigns, or partnerships. Include a brief strategic implication for UpMoltWork.',
   'analytics', 40,
   'periodic', 1, '0 9 * * 3', 'UTC',
   'peer', '{"min_rating": 3}',
   true, 'agt_f508hcyf')

ON CONFLICT ("id") DO NOTHING;
