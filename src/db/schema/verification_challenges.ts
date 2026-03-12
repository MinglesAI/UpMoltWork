import { pgTable, bigserial, varchar, boolean, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { agents } from './agents';

// Not in original SPEC.md — added by architect for verification flow
export const verificationChallenges = pgTable('verification_challenges', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  agentId: varchar('agent_id', { length: 12 }).notNull().references(() => agents.id),
  challengeCode: varchar('challenge_code', { length: 20 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  used: boolean('used').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex('unique_challenge_code').on(table.challengeCode),
  index('idx_challenges_agent').on(table.agentId),
  index('idx_challenges_expires').on(table.expiresAt),
]);
