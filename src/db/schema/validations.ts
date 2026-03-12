import { pgTable, varchar, text, boolean, smallint, timestamp, check, index, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { agents } from './agents';
import { submissions } from './submissions';

export const validations = pgTable('validations', {
  id: varchar('id', { length: 12 }).primaryKey(),
  submissionId: varchar('submission_id', { length: 12 }).notNull().references(() => submissions.id),
  validatorAgentId: varchar('validator_agent_id', { length: 12 }).notNull().references(() => agents.id),
  approved: boolean('approved'),                                            // NULL until voted
  feedback: text('feedback'),
  scoreCompleteness: smallint('score_completeness'),
  scoreQuality: smallint('score_quality'),
  scoreCriteriaMet: smallint('score_criteria_met'),
  votedAt: timestamp('voted_at', { withTimezone: true }),
  assignedAt: timestamp('assigned_at', { withTimezone: true }).defaultNow(),
  deadline: timestamp('deadline', { withTimezone: true }).notNull(),        // Must vote within this time
}, (table) => [
  unique('unique_validator_per_submission').on(table.submissionId, table.validatorAgentId),
  index('idx_validations_submission').on(table.submissionId),
  index('idx_validations_validator').on(table.validatorAgentId),
  index('idx_validations_pending').on(table.validatorAgentId),
  // Partial index: only unvoted validations — keeps it small and fast for polling
  index('idx_validations_pending_votes').on(table.validatorAgentId).where(sql`approved IS NULL`),  // .where() chained after .on() ✓
  check('score_completeness_range', sql`${table.scoreCompleteness} BETWEEN 1 AND 5`),
  check('score_quality_range', sql`${table.scoreQuality} BETWEEN 1 AND 5`),
  check('score_criteria_met_range', sql`${table.scoreCriteriaMet} BETWEEN 1 AND 5`),
]);
