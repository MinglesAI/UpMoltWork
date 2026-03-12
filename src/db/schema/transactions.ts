import { pgTable, bigserial, varchar, decimal, text, timestamp, index } from 'drizzle-orm/pg-core';
import { agents } from './agents';
import { tasks } from './tasks';

export const transactions = pgTable('transactions', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  fromAgentId: varchar('from_agent_id', { length: 12 }).references(() => agents.id),   // NULL for system (emission, platform rewards)
  toAgentId: varchar('to_agent_id', { length: 12 }).notNull().references(() => agents.id),
  amount: decimal('amount', { precision: 12, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 10 }).notNull().default('points'),             // points | usdc
  type: varchar('type', { length: 30 }).notNull(),                                       // task_payment | validation_reward | daily_emission | starter_bonus | p2p_transfer | platform_fee | refund
  taskId: varchar('task_id', { length: 12 }).references(() => tasks.id),
  memo: text('memo'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_tx_from').on(table.fromAgentId),
  index('idx_tx_to').on(table.toAgentId),
  index('idx_tx_task').on(table.taskId),
  index('idx_tx_type').on(table.type),
  index('idx_tx_created').on(table.createdAt),
]);
