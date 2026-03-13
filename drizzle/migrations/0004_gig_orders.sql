-- Gig Orders: lifecycle management for gig-based transactions
-- States: pending → accepted → delivered → completed
--                                        → revision_requested → delivered (loop)
--                                        → disputed → completed | cancelled
--         pending → cancelled
--         accepted → cancelled

CREATE TABLE "gig_orders" (
	"id"                  varchar(12) PRIMARY KEY NOT NULL,
	"gig_id"              varchar(12) NOT NULL,
	"buyer_agent_id"      varchar(12) NOT NULL,
	"seller_agent_id"     varchar(12) NOT NULL,
	"price_points"        numeric(12, 2),
	"price_usdc"          numeric(12, 6),
	"payment_mode"        varchar(10) NOT NULL DEFAULT 'points',
	"status"              varchar(20) NOT NULL DEFAULT 'pending',
	"requirements"        text,
	"delivery_url"        text,
	"delivery_content"    text,
	"delivery_notes"      text,
	"buyer_feedback"      text,
	"dispute_resolution"  text,
	"revision_count"      varchar(5) DEFAULT '0',
	"accepted_at"         timestamptz,
	"delivered_at"        timestamptz,
	"completed_at"        timestamptz,
	"cancelled_at"        timestamptz,
	"created_at"          timestamptz DEFAULT now(),
	"updated_at"          timestamptz DEFAULT now()
);

ALTER TABLE "gig_orders"
  ADD CONSTRAINT "gig_orders_gig_id_gigs_id_fk"
  FOREIGN KEY ("gig_id") REFERENCES "public"."gigs"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "gig_orders"
  ADD CONSTRAINT "gig_orders_buyer_agent_id_agents_id_fk"
  FOREIGN KEY ("buyer_agent_id") REFERENCES "public"."agents"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "gig_orders"
  ADD CONSTRAINT "gig_orders_seller_agent_id_agents_id_fk"
  FOREIGN KEY ("seller_agent_id") REFERENCES "public"."agents"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE INDEX "idx_gig_orders_gig"     ON "gig_orders" USING btree ("gig_id");
CREATE INDEX "idx_gig_orders_buyer"   ON "gig_orders" USING btree ("buyer_agent_id");
CREATE INDEX "idx_gig_orders_seller"  ON "gig_orders" USING btree ("seller_agent_id");
CREATE INDEX "idx_gig_orders_status"  ON "gig_orders" USING btree ("status");
CREATE INDEX "idx_gig_orders_created" ON "gig_orders" USING btree ("created_at");

-- Gigs table: if not yet created (new environments)
CREATE TABLE IF NOT EXISTS "gigs" (
	"id"               varchar(12) PRIMARY KEY NOT NULL,
	"creator_agent_id" varchar(12) NOT NULL,
	"title"            varchar(200) NOT NULL,
	"description"      text NOT NULL,
	"category"         varchar(30) NOT NULL,
	"price_points"     numeric(12, 2),
	"price_usdc"       numeric(12, 6),
	"status"           varchar(20) DEFAULT 'open',
	"created_at"       timestamptz DEFAULT now(),
	"updated_at"       timestamptz DEFAULT now()
);

ALTER TABLE "gigs"
  ADD CONSTRAINT IF NOT EXISTS "gigs_creator_agent_id_agents_id_fk"
  FOREIGN KEY ("creator_agent_id") REFERENCES "public"."agents"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE INDEX IF NOT EXISTS "idx_gigs_status"   ON "gigs" USING btree ("status");
CREATE INDEX IF NOT EXISTS "idx_gigs_category" ON "gigs" USING btree ("category");
CREATE INDEX IF NOT EXISTS "idx_gigs_creator"  ON "gigs" USING btree ("creator_agent_id");
CREATE INDEX IF NOT EXISTS "idx_gigs_created"  ON "gigs" USING btree ("created_at");
