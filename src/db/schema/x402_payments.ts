import { pgTable, bigserial, varchar, decimal, timestamp, index } from 'drizzle-orm/pg-core';
import { tasks } from './tasks.js';

export const x402Payments = pgTable('x402_payments', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  taskId: varchar('task_id', { length: 12 }).references(() => tasks.id),
  payerAddress: varchar('payer_address', { length: 42 }).notNull(),
  recipientAddress: varchar('recipient_address', { length: 42 }).notNull(),
  amountUsdc: decimal('amount_usdc', { precision: 12, scale: 6 }).notNull(),
  txHash: varchar('tx_hash', { length: 128 }).notNull().unique(),
  network: varchar('network', { length: 20 }).notNull(),
  paymentType: varchar('payment_type', { length: 20 }).notNull(), // 'escrow' | 'payout' | 'refund'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_x402_payments_task').on(table.taskId),
  index('idx_x402_payments_payer').on(table.payerAddress),
]);
