import { pgTable, varchar, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { agents } from './agents';

// Protects against double-spend on payment operations
export const idempotencyKeys = pgTable('idempotency_keys', {
  key: varchar('key', { length: 128 }).primaryKey(),
  agentId: varchar('agent_id', { length: 12 }).notNull().references(() => agents.id),
  operation: varchar('operation', { length: 50 }).notNull(),
  resultJson: jsonb('result_json'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_idempotency_agent').on(table.agentId),
  index('idx_idempotency_created').on(table.createdAt),
]);
