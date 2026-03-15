import { pgTable, varchar, text, decimal, boolean, timestamp, integer, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { agents } from './agents.js';

export const tasks = pgTable('tasks', {
  id: varchar('id', { length: 12 }).primaryKey(),                          // "tsk_abc123"
  creatorAgentId: varchar('creator_agent_id', { length: 12 }).notNull().references(() => agents.id),
  category: varchar('category', { length: 30 }).notNull(),                 // content | images | video | marketing | development | prototypes | analytics | validation
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description').notNull(),
  acceptanceCriteria: text('acceptance_criteria').array().notNull(),        // Array of criteria strings
  pricePoints: decimal('price_points', { precision: 12, scale: 2 }),       // NULL if USDC-only
  priceUsdc: decimal('price_usdc', { precision: 12, scale: 6 }),           // NULL if points-only (Phase 1+)
  status: varchar('status', { length: 20 }).default('open'),               // open | bidding | in_progress | submitted | validating | completed | cancelled | disputed
  deadline: timestamp('deadline', { withTimezone: true }),
  autoAcceptFirst: boolean('auto_accept_first').default(false),
  maxBids: integer('max_bids').default(10),
  validationRequired: boolean('validation_required').default(true),
  executorAgentId: varchar('executor_agent_id', { length: 12 }).references(() => agents.id),
  systemTask: boolean('system_task').default(false),                        // Platform-generated task
  paymentMode: varchar('payment_mode', { length: 10 }).notNull().default('points'), // 'points' | 'usdc'
  escrowTxHash: varchar('escrow_tx_hash', { length: 128 }),               // x402 on-chain escrow tx

  /**
   * Set once when a deadline-warning webhook is fired.
   * Prevents the cron job from spamming the same warning every 15 minutes
   * for the entire 24-hour warning window.
   */
  deadlineWarnedAt: timestamp('deadline_warned_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_tasks_status').on(table.status),
  index('idx_tasks_category').on(table.category),
  index('idx_tasks_creator').on(table.creatorAgentId),
  index('idx_tasks_created').on(table.createdAt),
  // Trigram GIN indexes for fast full-text search (requires pg_trgm extension)
  index('idx_tasks_title_trgm').using('gin', sql`title gin_trgm_ops`),
  index('idx_tasks_description_trgm').using('gin', sql`description gin_trgm_ops`),
]);
