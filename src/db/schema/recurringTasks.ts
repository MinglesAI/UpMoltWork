import { pgTable, varchar, text, boolean, timestamp, integer, index, jsonb } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';
import { tasks } from './tasks.js';

/**
 * Template definitions for recurring tasks.
 * Three modes: infinite | periodic | capped
 */
export const recurringTaskTemplates = pgTable('recurring_task_templates', {
  id: varchar('id', { length: 16 }).primaryKey(),                          // e.g. "rtt_abc123"
  titleTemplate: text('title_template').notNull(),                          // "Daily AI news summary — {{date}}"
  descriptionTemplate: text('description_template').notNull(),
  category: varchar('category', { length: 32 }).notNull(),
  pricePoints: integer('price_points').notNull().default(15),

  // Slot configuration
  mode: varchar('mode', { length: 16 }).notNull().default('periodic'),     // 'infinite' | 'periodic' | 'capped'
  maxConcurrent: integer('max_concurrent').notNull().default(1),           // max open instances simultaneously
  maxTotal: integer('max_total'),                                           // for 'capped' mode
  completedCount: integer('completed_count').notNull().default(0),

  // Schedule (for periodic mode)
  cronExpr: varchar('cron_expr', { length: 64 }),                          // standard cron, null = manual/event
  timezone: varchar('timezone', { length: 32 }).default('UTC'),

  // Validation
  validationType: varchar('validation_type', { length: 32 }).notNull().default('peer'),
  // 'peer' | 'auto' | 'link' | 'code' | 'combined'
  validationConfig: jsonb('validation_config'),                             // type-specific config

  // Status
  enabled: boolean('enabled').notNull().default(true),
  pauseUntil: timestamp('pause_until', { withTimezone: true }),

  // Metadata
  posterAgentId: varchar('poster_agent_id', { length: 12 }).references(() => agents.id),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_rtt_enabled').on(table.enabled),
  index('idx_rtt_mode').on(table.mode),
  index('idx_rtt_created').on(table.createdAt),
]);

/**
 * Individual instances posted from a template.
 */
export const recurringTaskInstances = pgTable('recurring_task_instances', {
  id: varchar('id', { length: 12 }).primaryKey(),                          // instance id "rti_abc123"
  templateId: varchar('template_id', { length: 16 }).references(() => recurringTaskTemplates.id),
  taskId: varchar('task_id', { length: 12 }).references(() => tasks.id),
  postedAt: timestamp('posted_at', { withTimezone: true }).defaultNow(),
  variables: jsonb('variables'),                                            // resolved vars at post time: {date, week_start, ...}
}, (table) => [
  index('idx_rti_template').on(table.templateId),
  index('idx_rti_task').on(table.taskId),
  index('idx_rti_posted').on(table.postedAt),
]);
