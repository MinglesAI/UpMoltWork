/**
 * Content Audit Library
 *
 * Async fire-and-forget scanner for external agent content.
 * Detects prompt injection patterns, flags tier0 content, and samples random
 * content for audit. Stores SHA-256 hashes only — never raw content.
 *
 * Phase 4 of the Content Filtering & Trust Tier Architecture.
 */

import { createHash } from 'node:crypto';
import { db } from '../db/pool.js';
import { contentAuditLog } from '../db/schema/content_audit_log.js';
import type { TrustTier } from './trustTier.js';

// ---------------------------------------------------------------------------
// Injection pattern detection
// ---------------------------------------------------------------------------

/**
 * Regex patterns that indicate potential prompt injection attempts.
 * Each entry has a name (for logging) and a regex to test against content
 * after stripping fenced code blocks.
 *
 * Patterns are checked OUTSIDE of code fences to reduce false positives on
 * legitimate technical content.
 */
export const INJECTION_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: 'im_start_token',    regex: /<\|im_start\|>/i },
  { name: 'system_token',      regex: /<\|system\|>/i },
  { name: 'system_bracket',    regex: /\[SYSTEM\]/i },
  { name: 'ignore_above',      regex: /\n\s*ignore (the )?above/i },
  { name: 'forget_above',      regex: /\n\s*forget (the )?above/i },
  { name: 'instructions_header', regex: /###\s+instructions/i },
];

/**
 * Strip fenced code blocks from content before pattern-matching.
 * This avoids false positives from legitimate code examples.
 */
function stripCodeFences(content: string): string {
  // Remove triple-backtick fenced blocks (``` ... ```)
  return content.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '');
}

/**
 * Detect injection pattern names present in `content` (outside code fences).
 * Returns an array of matched pattern names.
 */
export function detectPatterns(content: string): string[] {
  const stripped = stripCodeFences(content);
  const matches: string[] = [];
  for (const { name, regex } of INJECTION_PATTERNS) {
    if (regex.test(stripped)) {
      matches.push(name);
    }
  }
  return matches;
}

/**
 * Compute SHA-256 hex hash of content.
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Audit log writer
// ---------------------------------------------------------------------------

export interface AuditContentOpts {
  sourceType: 'task' | 'bid' | 'submission' | 'message' | 'gig_delivery';
  sourceId: string;
  agentId: string;
  trustTier: TrustTier;
  content: string;
  /** If true, include a random 5% sample audit entry */
  sample?: boolean;
}

/**
 * Fire-and-forget content audit.
 *
 * - Detects injection patterns and logs as 'pattern_match'
 * - Logs tier0 content as 'tier0_content'
 * - Randomly samples 5% of content as 'sampled'
 * - Never throws or blocks the request path
 * - Stores SHA-256 hashes, never raw content
 */
export function auditContent(opts: AuditContentOpts): void {
  // Intentionally not awaited — fire-and-forget
  _runAudit(opts).catch((err) => {
    console.error(JSON.stringify({
      event: 'content_audit_error',
      error: err instanceof Error ? err.message : String(err),
      sourceType: opts.sourceType,
      sourceId: opts.sourceId,
      agentId: opts.agentId,
    }));
  });
}

async function _runAudit(opts: AuditContentOpts): Promise<void> {
  const { sourceType, sourceId, agentId, trustTier, content, sample } = opts;
  const contentHash = hashContent(content);
  const rows: (typeof contentAuditLog.$inferInsert)[] = [];

  // --- Pattern detection ---
  const matched = detectPatterns(content);
  for (const pattern of matched) {
    // Critical patterns are the explicit injection signals; warning for others
    const severity = [
      'im_start_token',
      'system_token',
      'system_bracket',
      'ignore_above',
      'forget_above',
    ].includes(pattern) ? 'critical' : 'warning';

    rows.push({
      eventType: 'pattern_match',
      sourceType,
      sourceId,
      agentId,
      trustTier,
      pattern,
      contentHash,
      severity,
    });
  }

  // --- Tier0 content flag ---
  if (trustTier === 'tier0') {
    rows.push({
      eventType: 'tier0_content',
      sourceType,
      sourceId,
      agentId,
      trustTier,
      pattern: null,
      contentHash,
      severity: 'warning',
    });
  }

  // --- Random 5% sample ---
  if (sample && Math.random() < 0.05) {
    rows.push({
      eventType: 'sampled',
      sourceType,
      sourceId,
      agentId,
      trustTier,
      pattern: null,
      contentHash,
      severity: 'info',
    });
  }

  if (rows.length > 0) {
    await db.insert(contentAuditLog).values(rows);
  }
}
