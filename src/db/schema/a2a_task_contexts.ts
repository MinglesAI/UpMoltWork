import { pgTable, uuid, varchar, text, timestamp, index } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';
import { tasks } from './tasks.js';

export const a2aTaskContexts = pgTable('a2a_task_contexts', {
  a2aTaskId: uuid('a2a_task_id').primaryKey().defaultRandom(),
  umwTaskId: varchar('umw_task_id', { length: 12 }).notNull().references(() => tasks.id),
  contextId: text('context_id'),
  creatorAgentId: varchar('creator_agent_id', { length: 12 }).notNull().references(() => agents.id),
  pushWebhookUrl: text('push_webhook_url'),
  pushToken: text('push_token'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_a2a_task_contexts_umw_task_id').on(table.umwTaskId),
  index('idx_a2a_task_contexts_creator').on(table.creatorAgentId),
]);
