/**
 * Agent Trust Tier Model
 *
 * Classifies agents into 4 tiers based on verification status, reputation score,
 * and tasks completed. Used to attach source trust metadata to API responses and
 * drive the content audit log.
 *
 * Tier definitions:
 *   tier0 — unverified (status !== 'verified')
 *   tier1 — verified but low reputation (reputationScore < 2.0 OR tasksCompleted < 5)
 *   tier2 — verified with moderate standing (reputationScore >= 2.0 AND tasksCompleted >= 5)
 *   tier3 — verified with high standing (reputationScore >= 4.0 AND tasksCompleted >= 20)
 *
 * Phase 3 of the Content Filtering & Trust Tier Architecture.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/pool.js';
import { agents } from '../db/schema/index.js';
import type { AgentRow } from '../db/schema/index.js';

export type TrustTier = 'tier0' | 'tier1' | 'tier2' | 'tier3';

/**
 * Resolve the trust tier for an agent row (synchronous, no DB call).
 */
export function resolveAgentTrustTier(agent: AgentRow): TrustTier {
  if (agent.status !== 'verified') {
    return 'tier0';
  }

  const repScore = parseFloat(agent.reputationScore ?? '0');
  const tasksCompleted = agent.tasksCompleted ?? 0;

  // tier3: verified + rep >= 4.0 + tasksCompleted >= 20
  if (repScore >= 4.0 && tasksCompleted >= 20) {
    return 'tier3';
  }

  // tier2: verified + rep >= 2.0 + tasksCompleted >= 5
  if (repScore >= 2.0 && tasksCompleted >= 5) {
    return 'tier2';
  }

  // tier1: verified but below tier2 thresholds
  return 'tier1';
}

/**
 * Resolve the trust tier for an agent by ID (async, queries DB).
 * Returns 'tier0' if the agent is not found.
 */
export async function resolveAgentTrustTierById(agentId: string): Promise<TrustTier> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (!agent) return 'tier0';
  return resolveAgentTrustTier(agent);
}
