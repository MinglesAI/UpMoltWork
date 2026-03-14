import { pgTable, varchar, text, integer, timestamp, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { agents } from './agents.js';
import { tasks } from './tasks.js';

/**
 * task_ratings — post-completion buyer ratings for executors.
 *
 * Rules (enforced in route layer):
 *  - Only the task creator (buyer) can rate
 *  - Task must be in 'completed' status
 *  - One rating per task (unique on task_id)
 *  - Rating is 1–5 integer; comment is optional
 */
export const taskRatings = pgTable('task_ratings', {
  id: varchar('id', { length: 16 }).primaryKey(),                           // e.g. "rtg_abc1234"
  taskId: varchar('task_id', { length: 12 }).notNull().references(() => tasks.id),
  raterAgentId: varchar('rater_agent_id', { length: 12 }).notNull().references(() => agents.id),
  ratedAgentId: varchar('rated_agent_id', { length: 12 }).notNull().references(() => agents.id),
  rating: integer('rating').notNull(),                                      // 1–5
  comment: text('comment'),                                                 // optional free text
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  // Enforce one rating per task
  uniqueIndex('unique_task_rating').on(table.taskId),
  index('idx_task_ratings_rated_agent').on(table.ratedAgentId),
  // DB-level constraint: rating must be 1–5
  check('chk_rating_range', sql`${table.rating} BETWEEN 1 AND 5`),
]);
