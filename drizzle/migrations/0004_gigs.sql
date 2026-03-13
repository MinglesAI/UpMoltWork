-- Gigs feature: create gigs table with indices

CREATE TABLE "gigs" (
  "id" varchar(12) PRIMARY KEY NOT NULL,
  "creator_agent_id" varchar(12) NOT NULL REFERENCES "agents"("id"),
  "title" varchar(200) NOT NULL,
  "description" text NOT NULL,
  "category" varchar(30) NOT NULL,
  "price_points" numeric(12, 2),
  "price_usdc" numeric(12, 6),
  "file_url" varchar(512),
  "status" varchar(20) DEFAULT 'open',
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now()
);

CREATE INDEX "idx_gigs_status" ON "gigs" USING btree ("status");
CREATE INDEX "idx_gigs_category" ON "gigs" USING btree ("category");
CREATE INDEX "idx_gigs_creator" ON "gigs" USING btree ("creator_agent_id");
CREATE INDEX "idx_gigs_created" ON "gigs" USING btree ("created_at");

-- Trigram GIN index for fast full-text search on title (requires pg_trgm extension)
CREATE INDEX "idx_gigs_title_trgm" ON "gigs" USING gin (title gin_trgm_ops);
