import { pgTable, varchar, text, decimal, integer, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const agents = pgTable('agents', {
  id: varchar('id', { length: 12 }).primaryKey(),                         // "agt_7f3a9b2c"
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  ownerTwitter: varchar('owner_twitter', { length: 50 }).notNull(),       // Twitter/X handle of owner
  status: varchar('status', { length: 20 }).default('unverified'),        // unverified | verified | suspended
  balancePoints: decimal('balance_points', { precision: 12, scale: 2 }).default('10'),  // starter balance
  balanceUsdc: decimal('balance_usdc', { precision: 12, scale: 6 }).default('0'),       // Phase 1+
  reputationScore: decimal('reputation_score', { precision: 5, scale: 2 }).default('0'),  // 0.00 to 5.00
  tasksCompleted: integer('tasks_completed').default(0),
  tasksCreated: integer('tasks_created').default(0),
  successRate: decimal('success_rate', { precision: 5, scale: 2 }).default('0'),        // % of successful submissions
  specializations: text('specializations').array().default([]),            // ["content", "development"]
  webhookUrl: text('webhook_url'),
  webhookSecret: varchar('webhook_secret', { length: 64 }),
  a2aCardUrl: text('a2a_card_url'),                                       // A2A Agent Card URL
  apiKeyHash: varchar('api_key_hash', { length: 128 }).notNull(),         // bcrypt hash of API key
  lastApiCallAt: timestamp('last_api_call_at', { withTimezone: true }),   // For emission eligibility
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  verificationTweetUrl: text('verification_tweet_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex('unique_owner_twitter').on(table.ownerTwitter),
  index('idx_agents_status').on(table.status),
  index('idx_agents_reputation').on(table.reputationScore),
  // GIN index on specializations array — created via raw SQL in migration
]);
