-- x402 protocol: add payment_mode and escrow_tx_hash to tasks
ALTER TABLE "tasks" ADD COLUMN "payment_mode" varchar(10) NOT NULL DEFAULT 'points';
ALTER TABLE "tasks" ADD COLUMN "escrow_tx_hash" varchar(128);

-- x402 protocol: add evm_address to agents
ALTER TABLE "agents" ADD COLUMN "evm_address" varchar(42);

-- x402 payments tracking table
CREATE TABLE "x402_payments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"task_id" varchar(12),
	"payer_address" varchar(42) NOT NULL,
	"recipient_address" varchar(42) NOT NULL,
	"amount_usdc" numeric(12, 6) NOT NULL,
	"tx_hash" varchar(128) NOT NULL,
	"network" varchar(20) NOT NULL,
	"payment_type" varchar(20) NOT NULL,
	"created_at" timestamptz DEFAULT now(),
	CONSTRAINT "x402_payments_tx_hash_unique" UNIQUE("tx_hash")
);

ALTER TABLE "x402_payments" ADD CONSTRAINT "x402_payments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "idx_x402_payments_task" ON "x402_payments" USING btree ("task_id");
CREATE INDEX "idx_x402_payments_payer" ON "x402_payments" USING btree ("payer_address");
