/**
 * Emission test — validates the daily emission pg_cron job logic.
 * Manually runs the emission SQL for a test agent and verifies:
 *   - Only active verified agents receive emission
 *   - Balance cap at 5000 is enforced
 *   - Inactive agents (>7 days) are skipped
 *
 * Run: npm run test:emission
 * Requires: DATABASE_URL in .env (direct connection for pg_cron simulation)
 */

import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { dbDirect, initPool } from '../db/pool.js';
import { agents, transactions } from '../db/schema/index.js';

const TEST_ACTIVE = 'agt_emtest1';
const TEST_INACTIVE = 'agt_emtest2';
const TEST_CAPPED = 'agt_emtest3';
const TEST_UNVERIFIED = 'agt_emtest4';

async function setup() {
  console.log('🔧 Setting up emission test agents...');

  // Clean
  for (const id of [TEST_ACTIVE, TEST_INACTIVE, TEST_CAPPED, TEST_UNVERIFIED]) {
    await dbDirect.execute(sql`DELETE FROM transactions WHERE to_agent_id = ${id}`);
    await dbDirect.execute(sql`DELETE FROM agents WHERE id = ${id}`);
  }

  const now = new Date();
  const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);

  await dbDirect.insert(agents).values([
    {
      id: TEST_ACTIVE,
      name: 'Active Verified Agent',
      ownerTwitter: 'em_test_active',
      status: 'verified',
      balancePoints: '100',
      lastApiCallAt: now,
      apiKeyHash: 'hash1',
    },
    {
      id: TEST_INACTIVE,
      name: 'Inactive Agent (8 days)',
      ownerTwitter: 'em_test_inactive',
      status: 'verified',
      balancePoints: '100',
      lastApiCallAt: eightDaysAgo,
      apiKeyHash: 'hash2',
    },
    {
      id: TEST_CAPPED,
      name: 'Near-Cap Agent',
      ownerTwitter: 'em_test_capped',
      status: 'verified',
      balancePoints: '4995',  // 5 points below 5000 cap
      lastApiCallAt: now,
      apiKeyHash: 'hash3',
    },
    {
      id: TEST_UNVERIFIED,
      name: 'Unverified Agent',
      ownerTwitter: 'em_test_unverified',
      status: 'unverified',
      balancePoints: '100',
      lastApiCallAt: now,
      apiKeyHash: 'hash4',
    },
  ]);
  console.log('  ✅ Emission test agents created');
}

async function cleanup() {
  for (const id of [TEST_ACTIVE, TEST_INACTIVE, TEST_CAPPED, TEST_UNVERIFIED]) {
    await dbDirect.execute(sql`DELETE FROM transactions WHERE to_agent_id = ${id}`);
    await dbDirect.execute(sql`DELETE FROM agents WHERE id = ${id}`);
  }
  console.log('🧹 Test data cleaned up');
}

async function runEmissionSQL() {
  console.log('\n🔄 Running emission SQL (simulating pg_cron job)...');

  // Mirrors the pg_cron daily-emission job, filtered to test agents only.
  // Uses Drizzle transaction() to replicate the BEGIN/COMMIT semantics —
  // pg_cron executes the same SQL in a single transaction on the server.
  await dbDirect.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO transactions (from_agent_id, to_agent_id, amount, currency, type)
      SELECT NULL, id, 20, 'points', 'daily_emission'
      FROM agents
      WHERE id IN (${TEST_ACTIVE}, ${TEST_INACTIVE}, ${TEST_CAPPED}, ${TEST_UNVERIFIED})
        AND status = 'verified'
        AND last_api_call_at > NOW() - INTERVAL '7 days'
        AND balance_points < 5000
    `);

    await tx.execute(sql`
      UPDATE agents SET balance_points = LEAST(balance_points + 20, 5000)
      WHERE id IN (${TEST_ACTIVE}, ${TEST_INACTIVE}, ${TEST_CAPPED}, ${TEST_UNVERIFIED})
        AND status = 'verified'
        AND last_api_call_at > NOW() - INTERVAL '7 days'
        AND balance_points < 5000
    `);
  });
}

async function verifyResults() {
  console.log('\n📊 Verifying emission results...');

  const allAgents = await dbDirect
    .select({ id: agents.id, balance: agents.balancePoints, status: agents.status })
    .from(agents)
    .where(sql`id IN (${TEST_ACTIVE}, ${TEST_INACTIVE}, ${TEST_CAPPED}, ${TEST_UNVERIFIED})`);

  for (const agent of allAgents) {
    const balance = parseFloat(agent.balance ?? '0');
    console.log(`  ${agent.id}: ${balance} points (status: ${agent.status})`);
  }

  const active = allAgents.find(a => a.id === TEST_ACTIVE);
  const inactive = allAgents.find(a => a.id === TEST_INACTIVE);
  const capped = allAgents.find(a => a.id === TEST_CAPPED);
  const unverified = allAgents.find(a => a.id === TEST_UNVERIFIED);

  // Active verified should receive 20 points
  const activeBalance = parseFloat(active?.balance ?? '0');
  if (Math.abs(activeBalance - 120) > 0.01) {
    throw new Error(`Active agent should have 120 (100+20), got ${activeBalance}`);
  }
  console.log('\n  ✅ Active verified agent received emission (+20)');

  // Inactive should NOT receive emission
  const inactiveBalance = parseFloat(inactive?.balance ?? '0');
  if (Math.abs(inactiveBalance - 100) > 0.01) {
    throw new Error(`Inactive agent balance should be unchanged at 100, got ${inactiveBalance}`);
  }
  console.log('  ✅ Inactive agent skipped (>7 days without API call)');

  // Capped agent: was 4995, +20 would be 5015, capped to 5000
  const cappedBalance = parseFloat(capped?.balance ?? '0');
  if (Math.abs(cappedBalance - 5000) > 0.01) {
    throw new Error(`Capped agent should be at 5000 (LEAST(4995+20, 5000)), got ${cappedBalance}`);
  }
  console.log('  ✅ Near-cap agent capped at 5000 (not 5015)');

  // Unverified should NOT receive emission
  const unverifiedBalance = parseFloat(unverified?.balance ?? '0');
  if (Math.abs(unverifiedBalance - 100) > 0.01) {
    throw new Error(`Unverified agent balance should be unchanged at 100, got ${unverifiedBalance}`);
  }
  console.log('  ✅ Unverified agent skipped');
}

async function main() {
  console.log('🚀 UpMoltWork Emission Tests\n');
  await initPool();

  try {
    await setup();
    await runEmissionSQL();
    await verifyResults();
    console.log('\n✅ All emission tests passed!');
  } catch (err) {
    console.error('\n❌ Test failed:', err);
    process.exitCode = 1;
  } finally {
    if (!process.env.KEEP_TEST_DATA) { await cleanup(); } else { console.log("🔒 KEEP_TEST_DATA set — skipping cleanup"); }
    process.exit(process.exitCode ?? 0);
  }
}

main();
