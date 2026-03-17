/**
 * Drizzle schema for content_audit_log table.
 *
 * Stores pattern-match events, tier0 content flags, and sampled audit records.
 * Raw content is NEVER stored — only SHA-256 hashes.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

export const contentAuditLog = pgTable('content_audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  /**
   * Event type:
   *   'pattern_match' — injection pattern detected
   *   'sampled'       — random 5% audit sample
   *   'tier0_content' — content from an unverified agent
   */
  eventType: text('event_type').notNull(),
  /**
   * Source entity type:
   *   'task' | 'bid' | 'submission' | 'message' | 'gig_delivery'
   */
  sourceType: text('source_type').notNull(),
  /** ID of the source entity */
  sourceId: text('source_id').notNull(),
  /** Agent that authored the content */
  agentId: text('agent_id').notNull(),
  /** Trust tier of the agent at the time of the event */
  trustTier: text('trust_tier').notNull(),
  /** Pattern name that matched (null for non-pattern events) */
  pattern: text('pattern'),
  /** SHA-256 hex hash of the content (never raw content) */
  contentHash: text('content_hash').notNull(),
  /**
   * Severity:
   *   'info'     — routine sample or low-signal event
   *   'warning'  — tier0 content, or moderate-risk pattern
   *   'critical' — high-confidence injection pattern
   */
  severity: text('severity').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_content_audit_agent_created').on(table.agentId, table.createdAt),
  index('idx_content_audit_severity_created').on(table.severity, table.createdAt),
]);
