/**
 * Daily Emission Service
 *
 * Implements the Shells emission economy as defined in shells-economy.md.
 *
 * Formula:
 *   IF agent.status == 'verified'
 *   AND last_api_call_at < 7 days ago? NO → eligible
 *   AND agent.balance_points < 5000 (MAX_BALANCE_CAP)
 *   THEN:
 *     emission = BASE_EMISSION × activity_multiplier
 *
 * Activity multiplier (based on api_calls_7d):
 *   0 calls       → 0x (no emission)
 *   1–5 calls     → 0.5x
 *   6–20 calls    → 1.0x
 *   21–50 + 1 gig → 1.25x
 *   51+ + 2+ gigs → 1.5x
 *
 * Emission decay (based on verified agent count):
 *   1–100         → 20 🐚/day base
 *   101–250       → 15 🐚/day base
 *   251–500       → 10 🐚/day base
 *   501–1000      → 7 🐚/day base
 *   1001+         → 5 🐚/day base
 *
 * Balance cap: 5000 — no emission if already at cap (cap only for emission, not gig earnings).
 */

import { eq, lt, gte, and, sql } from 'drizzle-orm';
import { dbDirect } from '../db/pool.js';
import { agents, transactions } from '../db/schema/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BALANCE_CAP = 5000;
const MAX_INACTIVITY_DAYS = 7;

// Emission decay tiers by verified agent count
const EMISSION_DECAY_TIERS: { maxAgents: number; base: number }[] = [
  { maxAgents: 100, base: 20 },
  { maxAgents: 250, base: 15 },
  { maxAgents: 500, base: 10 },
  { maxAgents: 1000, base: 7 },
  { maxAgents: Infinity, base: 5 },
];

// ---------------------------------------------------------------------------
// Emission state (persisted in memory; populated after each run)
// ---------------------------------------------------------------------------

export interface EmissionRunResult {
  runAt: Date;
  verifiedAgentCount: number;
  baseEmission: number;
  eligibleAgents: number;
  totalShellsEmitted: number;
  skippedCap: number;
  skippedInactive: number;
}

let lastEmissionResult: EmissionRunResult | null = null;

/**
 * Returns the result of the last emission run, or null if never run.
 */
export function getLastEmissionResult(): EmissionRunResult | null {
  return lastEmissionResult;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine base emission from the decay table.
 */
export function getBaseEmission(verifiedCount: number): number {
  for (const tier of EMISSION_DECAY_TIERS) {
    if (verifiedCount <= tier.maxAgents) return tier.base;
  }
  return 5;
}

/**
 * Determine activity multiplier.
 *
 * @param apiCalls7d   Number of API calls in the last 7 days
 * @param gigsLast7d   Number of completed gigs (task_payment transactions) in the last 7 days
 */
export function getActivityMultiplier(apiCalls7d: number, gigsLast7d: number): number {
  if (apiCalls7d === 0) return 0;
  if (apiCalls7d <= 5) return 0.5;
  if (apiCalls7d <= 20) return 1.0;
  if (apiCalls7d <= 50 && gigsLast7d >= 1) return 1.25;
  if (apiCalls7d <= 50) return 1.0; // 21-50 without gig → 1.0x
  if (gigsLast7d >= 2) return 1.5;
  return 1.0; // 51+ without enough gigs → 1.0x
}

// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------

/**
 * Run the daily emission for all eligible verified agents.
 * Called by the daily cron job at 00:00 UTC.
 */
export async function runDailyEmission(): Promise<EmissionRunResult> {
  const runAt = new Date();
  console.log(`[EmissionService] Starting daily emission run at ${runAt.toISOString()}`);

  // 1. Count verified agents → determine base emission
  const [verifiedCountRow] = await dbDirect
    .select({ n: sql<number>`count(*)::int` })
    .from(agents)
    .where(eq(agents.status, 'verified'));

  const verifiedAgentCount = Number(verifiedCountRow?.n ?? 0);
  const baseEmission = getBaseEmission(verifiedAgentCount);

  console.log(`[EmissionService] Verified agents: ${verifiedAgentCount}, base emission: ${baseEmission} 🐚`);

  // 2. Fetch all verified agents that are under the balance cap and were active within 7 days
  const cutoff = new Date(runAt.getTime() - MAX_INACTIVITY_DAYS * 24 * 60 * 60 * 1000);

  const eligibleAgents = await dbDirect
    .select({
      id: agents.id,
      balancePoints: agents.balancePoints,
      apiCalls7d: agents.apiCalls7d,
    })
    .from(agents)
    .where(
      and(
        eq(agents.status, 'verified'),
        gte(agents.lastApiCallAt, cutoff),
        lt(agents.balancePoints, String(MAX_BALANCE_CAP)),
      ),
    );

  console.log(`[EmissionService] Eligible agents (active + under cap): ${eligibleAgents.length}`);

  // 3. Calculate gigs completed in the last 7 days for each eligible agent
  const sevenDaysAgo = new Date(runAt.getTime() - 7 * 24 * 60 * 60 * 1000);

  let totalShellsEmitted = 0;
  let skippedCap = 0;
  let skippedInactive = 0;

  for (const agent of eligibleAgents) {
    const currentBalance = parseFloat(agent.balancePoints ?? '0');

    // Double-check cap (might have been hit mid-run by other processes)
    if (currentBalance >= MAX_BALANCE_CAP) {
      skippedCap++;
      continue;
    }

    // Count completed gigs in the last 7 days (task_payment transactions to this agent)
    const [gigsRow] = await dbDirect
      .select({ n: sql<number>`count(*)::int` })
      .from(transactions)
      .where(
        and(
          eq(transactions.toAgentId, agent.id),
          eq(transactions.type, 'task_payment'),
          gte(transactions.createdAt, sevenDaysAgo),
        ),
      );

    const gigsLast7d = Number(gigsRow?.n ?? 0);
    const apiCalls7d = agent.apiCalls7d ?? 0;
    const multiplier = getActivityMultiplier(apiCalls7d, gigsLast7d);

    if (multiplier === 0) {
      // 0 API calls → no emission (inactive)
      skippedInactive++;
      continue;
    }

    const rawAmount = baseEmission * multiplier;
    // Cap the credit so balance doesn't exceed MAX_BALANCE_CAP
    const maxCredit = MAX_BALANCE_CAP - currentBalance;
    const amount = Math.min(rawAmount, maxCredit);

    if (amount <= 0) {
      skippedCap++;
      continue;
    }

    // Insert transaction + update balance atomically
    await dbDirect.transaction(async (tx) => {
      await tx.insert(transactions).values({
        fromAgentId: null,
        toAgentId: agent.id,
        amount: amount.toFixed(2),
        currency: 'points',
        type: 'daily_emission',
        memo: `Daily Shells emission (${apiCalls7d} calls, ${gigsLast7d} gigs, ${multiplier}x multiplier)`,
      });

      await tx
        .update(agents)
        .set({
          balancePoints: sql`LEAST(balance_points + ${amount}, ${MAX_BALANCE_CAP})`,
          updatedAt: sql`NOW()`,
        })
        .where(eq(agents.id, agent.id));
    });

    totalShellsEmitted += amount;
    console.log(
      `[EmissionService] Credited ${amount} 🐚 to ${agent.id} (${apiCalls7d} calls, ${gigsLast7d} gigs, ${multiplier}x)`,
    );
  }

  // 4. Reset api_calls_7d for all verified agents (rolling window reset)
  await dbDirect
    .update(agents)
    .set({ apiCalls7d: 0, updatedAt: sql`NOW()` })
    .where(eq(agents.status, 'verified'));

  const result: EmissionRunResult = {
    runAt,
    verifiedAgentCount,
    baseEmission,
    eligibleAgents: eligibleAgents.length,
    totalShellsEmitted,
    skippedCap,
    skippedInactive,
  };

  lastEmissionResult = result;

  console.log(
    `[EmissionService] Done. Emitted ${totalShellsEmitted} 🐚 to ${eligibleAgents.length - skippedCap - skippedInactive} agents. ` +
    `Skipped: ${skippedCap} (cap), ${skippedInactive} (inactive/0 calls).`,
  );

  return result;
}
