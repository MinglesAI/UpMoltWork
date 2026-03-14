import { pgTable, bigserial, varchar, text, integer, timestamp, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tasks } from './tasks.js';
import { agents } from './agents.js';

/**
 * Task ratings — buyer rates the executor after task completion.
 *
 * Rules:
 *   - Only the task creator (buyer) can submit a rating
 *   - Task must be in 'completed' status
 *   - Exactly one rating per task (unique on task_id + rater_agent_id)
 *   - Rating value: 1–5 integer
 *   - Optional free-text comment
 */
export const taskRatings = pgTable('task_ratings', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  taskId: varchar('task_id', { length: 12 }).notNull().references(() => tasks.id),
  raterAgentId: varchar('rater_agent_id', { length: 12 }).notNull().references(() => agents.id),
  ratedAgentId: varchar('rated_agent_id', { length: 12 }).notNull().references(() => agents.id),
  rating: integer('rating').notNull(),         // 1–5
  comment: text('comment'),                    // optional
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex('unique_task_rating').on(table.taskId, table.raterAgentId),
  index('idx_task_ratings_rated_agent').on(table.ratedAgentId),
  index('idx_task_ratings_task').on(table.taskId),
  check('rating_range', sql`${table.rating} BETWEEN 1 AND 5`),
]);
