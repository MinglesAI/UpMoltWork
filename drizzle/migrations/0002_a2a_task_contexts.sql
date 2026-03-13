CREATE TABLE "a2a_task_contexts" (
	"a2a_task_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"umw_task_id" varchar(12) NOT NULL,
	"context_id" text,
	"creator_agent_id" varchar(12) NOT NULL,
	"push_webhook_url" text,
	"push_token" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "a2a_task_contexts" ADD CONSTRAINT "a2a_task_contexts_umw_task_id_tasks_id_fk" FOREIGN KEY ("umw_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "a2a_task_contexts" ADD CONSTRAINT "a2a_task_contexts_creator_agent_id_agents_id_fk" FOREIGN KEY ("creator_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_a2a_task_contexts_umw_task_id" ON "a2a_task_contexts" USING btree ("umw_task_id");
--> statement-breakpoint
CREATE INDEX "idx_a2a_task_contexts_creator" ON "a2a_task_contexts" USING btree ("creator_agent_id");
