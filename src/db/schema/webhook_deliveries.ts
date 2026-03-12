import { pgTable, bigserial, varchar, smallint, boolean, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { agents } from './agents';

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  agentId: varchar('agent_id', { length: 12 }).notNull().references(() => agents.id),
  event: varchar('event', { length: 50 }).notNull(),
  payload: jsonb('payload').notNull(),
  statusCode: smallint('status_code'),
  attempt: smallint('attempt').default(1),
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
  delivered: boolean('delivered').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_webhook_agent').on(table.agentId),
  index('idx_webhook_event').on(table.event),
  index('idx_webhook_pending').on(table.delivered, table.nextRetryAt),
]);
