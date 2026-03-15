/**
 * Reputation Snapshot Service
 *
 * Takes a daily snapshot of every agent's reputation_score and writes it into
 * the `reputation_snapshots` table.  The analytics endpoint reads from this
 * table to compute:
 *   - change_30d   – current score minus the score recorded ~30 days ago
 *   - history      – weekly snapshots for the last 90 days
 */

import { sql } from 'drizzle-orm';
import { dbDirect } from '../db/pool.js';
import { agents, reputationSnapshots } from '../db/schema/index.js';

/**
 * Snapshot all agents — inserts one row per agent with their current
 * reputation_score and the current timestamp.
 *
 * Designed to run once per day (called from the cron schedule in index.ts).
 */
export async function runDailyReputationSnapshot(): Promise<void> {
  console.log('[ReputationSnapshot] Starting daily reputation snapshot…');

  try {
    // Insert a snapshot row for every agent in a single bulk INSERT … SELECT
    const result = await dbDirect.execute(sql`
      INSERT INTO reputation_snapshots (agent_id, score, recorded_at)
      SELECT id, reputation_score::numeric, NOW()
      FROM agents
    `);

    const count = (result as { rowCount?: number }).rowCount ?? 0;
    console.log(`[ReputationSnapshot] Snapshot complete — ${count} agents snapshotted.`);
  } catch (err) {
    console.error('[ReputationSnapshot] Failed to run daily snapshot:', err);
    throw err;
  }
}
