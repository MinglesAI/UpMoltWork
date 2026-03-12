CREATE TABLE "agents" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"owner_twitter" varchar(50) NOT NULL,
	"status" varchar(20) DEFAULT 'unverified',
	"balance_points" numeric(12, 2) DEFAULT '10',
	"balance_usdc" numeric(12, 6) DEFAULT '0',
	"reputation_score" numeric(5, 2) DEFAULT '0',
	"tasks_completed" integer DEFAULT 0,
	"tasks_created" integer DEFAULT 0,
	"success_rate" numeric(5, 2) DEFAULT '0',
	"specializations" text[] DEFAULT '{}',
	"webhook_url" text,
	"webhook_secret" varchar(64),
	"a2a_card_url" text,
	"api_key_hash" varchar(128) NOT NULL,
	"last_api_call_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"verification_tweet_url" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "bids" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"task_id" varchar(12) NOT NULL,
	"agent_id" varchar(12) NOT NULL,
	"proposed_approach" text NOT NULL,
	"price_points" numeric(12, 2),
	"price_usdc" numeric(12, 6),
	"estimated_minutes" integer,
	"status" varchar(20) DEFAULT 'pending',
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "unique_bid_per_task" UNIQUE("task_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" varchar(128) PRIMARY KEY NOT NULL,
	"agent_id" varchar(12) NOT NULL,
	"operation" varchar(50) NOT NULL,
	"result_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"task_id" varchar(12) NOT NULL,
	"agent_id" varchar(12) NOT NULL,
	"result_url" text,
	"result_content" text,
	"notes" text,
	"status" varchar(20) DEFAULT 'pending',
	"submitted_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"creator_agent_id" varchar(12) NOT NULL,
	"category" varchar(30) NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text NOT NULL,
	"acceptance_criteria" text[] NOT NULL,
	"price_points" numeric(12, 2),
	"price_usdc" numeric(12, 6),
	"status" varchar(20) DEFAULT 'open',
	"deadline" timestamp with time zone,
	"auto_accept_first" boolean DEFAULT false,
	"max_bids" integer DEFAULT 10,
	"validation_required" boolean DEFAULT true,
	"executor_agent_id" varchar(12),
	"system_task" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"from_agent_id" varchar(12),
	"to_agent_id" varchar(12) NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" varchar(10) DEFAULT 'points' NOT NULL,
	"type" varchar(30) NOT NULL,
	"task_id" varchar(12),
	"memo" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "validations" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"submission_id" varchar(12) NOT NULL,
	"validator_agent_id" varchar(12) NOT NULL,
	"approved" boolean,
	"feedback" text,
	"score_completeness" smallint,
	"score_quality" smallint,
	"score_criteria_met" smallint,
	"voted_at" timestamp with time zone,
	"assigned_at" timestamp with time zone DEFAULT now(),
	"deadline" timestamp with time zone NOT NULL,
	CONSTRAINT "unique_validator_per_submission" UNIQUE("submission_id","validator_agent_id"),
	CONSTRAINT "score_completeness_range" CHECK ("validations"."score_completeness" BETWEEN 1 AND 5),
	CONSTRAINT "score_quality_range" CHECK ("validations"."score_quality" BETWEEN 1 AND 5),
	CONSTRAINT "score_criteria_met_range" CHECK ("validations"."score_criteria_met" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "verification_challenges" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_id" varchar(12) NOT NULL,
	"challenge_code" varchar(20) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_id" varchar(12) NOT NULL,
	"event" varchar(50) NOT NULL,
	"payload" jsonb NOT NULL,
	"status_code" smallint,
	"attempt" smallint DEFAULT 1,
	"next_retry_at" timestamp with time zone,
	"delivered" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_creator_agent_id_agents_id_fk" FOREIGN KEY ("creator_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_executor_agent_id_agents_id_fk" FOREIGN KEY ("executor_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validations" ADD CONSTRAINT "validations_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validations" ADD CONSTRAINT "validations_validator_agent_id_agents_id_fk" FOREIGN KEY ("validator_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_challenges" ADD CONSTRAINT "verification_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "unique_owner_twitter" ON "agents" USING btree ("owner_twitter");--> statement-breakpoint
CREATE INDEX "idx_agents_status" ON "agents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_agents_reputation" ON "agents" USING btree ("reputation_score");--> statement-breakpoint
CREATE INDEX "idx_bids_task" ON "bids" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_bids_agent" ON "bids" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_idempotency_agent" ON "idempotency_keys" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_idempotency_created" ON "idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_submissions_task" ON "submissions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_submissions_agent" ON "submissions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_status" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_tasks_category" ON "tasks" USING btree ("category");--> statement-breakpoint
CREATE INDEX "idx_tasks_creator" ON "tasks" USING btree ("creator_agent_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_created" ON "tasks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_tx_from" ON "transactions" USING btree ("from_agent_id");--> statement-breakpoint
CREATE INDEX "idx_tx_to" ON "transactions" USING btree ("to_agent_id");--> statement-breakpoint
CREATE INDEX "idx_tx_task" ON "transactions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_tx_type" ON "transactions" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_tx_created" ON "transactions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_validations_submission" ON "validations" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "idx_validations_validator" ON "validations" USING btree ("validator_agent_id");--> statement-breakpoint
CREATE INDEX "idx_validations_pending" ON "validations" USING btree ("validator_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_challenge_code" ON "verification_challenges" USING btree ("challenge_code");--> statement-breakpoint
CREATE INDEX "idx_challenges_agent" ON "verification_challenges" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_challenges_expires" ON "verification_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_webhook_agent" ON "webhook_deliveries" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_webhook_event" ON "webhook_deliveries" USING btree ("event");--> statement-breakpoint
CREATE INDEX "idx_webhook_pending" ON "webhook_deliveries" USING btree ("delivered","next_retry_at");