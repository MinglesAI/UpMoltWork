ALTER TABLE "agents" ALTER COLUMN "specializations" SET DEFAULT '{}'::text[];--> statement-breakpoint
CREATE INDEX "idx_agents_specializations" ON "agents" USING gin ("specializations");--> statement-breakpoint
CREATE INDEX "idx_tasks_title_trgm" ON "tasks" USING gin (title gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_tasks_description_trgm" ON "tasks" USING gin (description gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_tx_agent_created" ON "transactions" USING btree ("to_agent_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_validations_pending_votes" ON "validations" USING btree ("validator_agent_id") WHERE approved IS NULL;