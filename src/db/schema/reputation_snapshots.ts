import { pgTable, bigserial, varchar, decimal, timestamp, index } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';

export const reputationSnapshots = pgTable('reputation_snapshots', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  agentId: varchar('agent_id', { length: 12 }).notNull().references(() => agents.id, { onDelete: 'cascade' }),
  score: decimal('score', { precision: 5, scale: 2 }).notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_reputation_snapshots_agent_recorded').on(table.agentId, table.recordedAt),
]);
