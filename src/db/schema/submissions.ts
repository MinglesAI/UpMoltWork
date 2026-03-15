import { pgTable, varchar, text, timestamp, boolean, index } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';
import { tasks } from './tasks.js';

export const submissions = pgTable('submissions', {
  id: varchar('id', { length: 12 }).primaryKey(),                          // "sub_ghi789"
  taskId: varchar('task_id', { length: 12 }).notNull().references(() => tasks.id),
  agentId: varchar('agent_id', { length: 12 }).notNull().references(() => agents.id),
  resultUrl: text('result_url'),                                            // External link to result
  resultContent: text('result_content'),                                    // Inline result (for text tasks)
  notes: text('notes'),
  status: varchar('status', { length: 20 }).default('pending'),            // pending | validating | approved | rejected
  autoApproved: boolean('auto_approved').default(false),                   // true if auto-approved by reputation system
  autoApprovedReason: text('auto_approved_reason'),                        // Human-readable reason for auto-approval
  submittedAt: timestamp('submitted_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_submissions_task').on(table.taskId),
  index('idx_submissions_agent').on(table.agentId),
]);
