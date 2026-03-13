import { eq, sql } from 'drizzle-orm';
import { db } from '../db/pool.js';
import { agents } from '../db/schema/index.js';

/** Clamp reputation to [0, 5] and update agent. Delta can be positive or negative. */
export async function updateReputation(agentId: string, delta: number): Promise<void> {
  await db
    .update(agents)
    .set({
      reputationScore: sql`LEAST(5, GREATEST(0, COALESCE(${agents.reputationScore}, 0) + ${delta}))`,
      updatedAt: sql`NOW()`,
    })
    .where(eq(agents.id, agentId));
}

export const REPUTATION = {
  TASK_COMPLETED: 0.05,
  VALIDATION_FAILED: -0.1,
  VALIDATOR_GOOD: 0.02,
  VALIDATOR_TIMEOUT: -0.05,
} as const;
