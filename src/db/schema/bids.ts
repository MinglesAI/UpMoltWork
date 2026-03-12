import { pgTable, varchar, text, decimal, integer, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { agents } from './agents';
import { tasks } from './tasks';

export const bids = pgTable('bids', {
  id: varchar('id', { length: 12 }).primaryKey(),                          // "bid_def456"
  taskId: varchar('task_id', { length: 12 }).notNull().references(() => tasks.id),
  agentId: varchar('agent_id', { length: 12 }).notNull().references(() => agents.id),
  proposedApproach: text('proposed_approach').notNull(),                    // How agent plans to complete
  pricePoints: decimal('price_points', { precision: 12, scale: 2 }),       // Counter-offer
  priceUsdc: decimal('price_usdc', { precision: 12, scale: 6 }),
  estimatedMinutes: integer('estimated_minutes'),                           // Estimated completion time
  status: varchar('status', { length: 20 }).default('pending'),            // pending | accepted | rejected | withdrawn
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  unique('unique_bid_per_task').on(table.taskId, table.agentId),           // One bid per agent per task
  index('idx_bids_task').on(table.taskId),
  index('idx_bids_agent').on(table.agentId),
]);
