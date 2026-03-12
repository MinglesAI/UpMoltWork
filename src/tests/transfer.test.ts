/**
 * Transfer tests — validates:
 *   1. Concurrent transfer race condition safety
 *   2. Insufficient balance rejection
 *   3. Atomic balance updates (no partial state)
 *
 * Run: npm run test:transfer
 * Requires: DATABASE_URL and DATABASE_POOLER_URL in .env
 */

import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { dbDirect, db } from '../db/pool.js';
import { agents, transactions } from '../db/schema/index.js';
import { transferShells, systemCredit } from '../lib/transfer.js';

const TEST_AGENT_A = 'agt_test001';
const TEST_AGENT_B = 'agt_test002';
const TEST_SYSTEM = 'agt_system';

async function setup() {
  console.log('🔧 Setting up test agents...');

  // Clean existing test data
  await dbDirect.execute(sql`DELETE FROM transactions WHERE from_agent_id IN (${TEST_AGENT_A}, ${TEST_AGENT_B}) OR to_agent_id IN (${TEST_AGENT_A}, ${TEST_AGENT_B})`);
  await dbDirect.execute(sql`DELETE FROM agents WHERE id IN (${TEST_AGENT_A}, ${TEST_AGENT_B})`);

  // Create test agents
  await dbDirect.insert(agents).values([
    {
      id: TEST_AGENT_A,
      name: 'Test Agent A',
      ownerTwitter: 'test_agent_a',
      status: 'verified',
      balancePoints: '200',
      apiKeyHash: 'test_hash_a',
    },
    {
      id: TEST_AGENT_B,
      name: 'Test Agent B',
      ownerTwitter: 'test_agent_b',
      status: 'verified',
      balancePoints: '0',
      apiKeyHash: 'test_hash_b',
    },
  ]);
  console.log('  ✅ Test agents created (A: 200 points, B: 0 points)');
}

async function cleanup() {
  await dbDirect.execute(sql`DELETE FROM transactions WHERE from_agent_id IN (${TEST_AGENT_A}, ${TEST_AGENT_B}) OR to_agent_id IN (${TEST_AGENT_A}, ${TEST_AGENT_B})`);
  await dbDirect.execute(sql`DELETE FROM agents WHERE id IN (${TEST_AGENT_A}, ${TEST_AGENT_B})`);
  console.log('🧹 Test data cleaned up');
}

async function test1_sufficientBalance() {
  console.log('\n📋 Test 1: Successful transfer with sufficient balance');

  const result = await transferShells({
    fromAgentId: TEST_AGENT_A,
    toAgentId: TEST_AGENT_B,
    amount: 100,
    type: 'p2p_transfer',
    memo: 'Test transfer',
  });

  const [agentA] = await db.select({ balance: agents.balancePoints }).from(agents).where(eq(agents.id, TEST_AGENT_A));
  const [agentB] = await db.select({ balance: agents.balancePoints }).from(agents).where(eq(agents.id, TEST_AGENT_B));

  const aBalance = parseFloat(agentA.balance ?? '0');
  const bBalance = parseFloat(agentB.balance ?? '0');

  if (Math.abs(aBalance - 100) > 0.01) throw new Error(`Agent A balance should be ~100, got ${aBalance}`);
  if (Math.abs(bBalance - 95) > 0.01) throw new Error(`Agent B balance should be ~95 (after 5% fee), got ${bBalance}`);
  if (Math.abs(result.netAmount - 95) > 0.01) throw new Error(`Net amount should be 95, got ${result.netAmount}`);
  if (Math.abs(result.platformFee - 5) > 0.01) throw new Error(`Platform fee should be 5, got ${result.platformFee}`);

  console.log(`  ✅ Transfer succeeded: A=${aBalance} B=${bBalance} fee=${result.platformFee}`);

  // Reset for next test
  await dbDirect.update(agents).set({ balancePoints: '200' }).where(eq(agents.id, TEST_AGENT_A));
  await dbDirect.update(agents).set({ balancePoints: '0' }).where(eq(agents.id, TEST_AGENT_B));
  await dbDirect.execute(sql`DELETE FROM transactions WHERE from_agent_id = ${TEST_AGENT_A}`);
}

async function test2_insufficientBalance() {
  console.log('\n📋 Test 2: Insufficient balance rejection');

  try {
    await transferShells({
      fromAgentId: TEST_AGENT_A,
      toAgentId: TEST_AGENT_B,
      amount: 10000, // Way more than 200
      type: 'p2p_transfer',
    });
    throw new Error('Should have thrown insufficient balance error');
  } catch (err) {
    const error = err as Error;
    if (!error.message.includes('Insufficient balance')) {
      throw new Error(`Wrong error: ${error.message}`);
    }
    console.log(`  ✅ Correctly rejected: "${error.message}"`);
  }

  // Verify balances unchanged
  const [agentA] = await db.select({ balance: agents.balancePoints }).from(agents).where(eq(agents.id, TEST_AGENT_A));
  const aBalance = parseFloat(agentA.balance ?? '0');
  if (Math.abs(aBalance - 200) > 0.01) throw new Error(`Agent A balance should be 200 unchanged, got ${aBalance}`);
  console.log(`  ✅ Balances unchanged: A=${aBalance}`);
}

async function test3_concurrentTransfers() {
  console.log('\n📋 Test 3: Concurrent transfers (race condition check)');
  console.log('  Attempting 5 concurrent transfers of 50 points each from A (has 200)');
  console.log('  Expected: exactly 4 succeed (200/50=4), 1 fails with Insufficient balance');

  // Reset A to 200
  await dbDirect.update(agents).set({ balancePoints: '200' }).where(eq(agents.id, TEST_AGENT_A));
  await dbDirect.execute(sql`DELETE FROM transactions WHERE from_agent_id = ${TEST_AGENT_A}`);

  // Launch 5 concurrent transfers (only 4 can succeed: 200/50=4)
  const promises = Array(5).fill(null).map((_, i) =>
    transferShells({
      fromAgentId: TEST_AGENT_A,
      toAgentId: TEST_AGENT_B,
      amount: 50,
      type: 'p2p_transfer',
      memo: `Concurrent transfer ${i + 1}`,
    }).then(r => ({ success: true, ...r })).catch(e => ({ success: false, error: (e as Error).message }))
  );

  const results = await Promise.all(promises);

  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  console.log(`  Results: ${succeeded} succeeded, ${failed} failed`);
  for (const r of results) {
    if (r.success) {
      console.log(`    ✅ Success`);
    } else {
      console.log(`    ❌ Failed: ${(r as { error: string }).error}`);
    }
  }

  // Verify final balance is 0 (200 - 4×50 = 0)
  const [agentA] = await db.select({ balance: agents.balancePoints }).from(agents).where(eq(agents.id, TEST_AGENT_A));
  const aBalance = parseFloat(agentA.balance ?? '0');

  if (succeeded !== 4) throw new Error(`Expected exactly 4 successes, got ${succeeded}`);
  if (failed !== 1) throw new Error(`Expected exactly 1 failure, got ${failed}`);
  if (Math.abs(aBalance) > 0.01) throw new Error(`Agent A balance should be ~0, got ${aBalance}`);

  console.log(`  ✅ Race condition handled correctly: A final balance = ${aBalance}`);
}

async function test4_systemCredit() {
  console.log('\n📋 Test 4: System credit (emission simulation)');

  await dbDirect.update(agents).set({ balancePoints: '0' }).where(eq(agents.id, TEST_AGENT_A));

  const { transactionId } = await systemCredit({
    toAgentId: TEST_AGENT_A,
    amount: 20,
    type: 'daily_emission',
    memo: 'Daily emission test',
  });

  const [agentA] = await db.select({ balance: agents.balancePoints }).from(agents).where(eq(agents.id, TEST_AGENT_A));
  const aBalance = parseFloat(agentA.balance ?? '0');

  if (Math.abs(aBalance - 20) > 0.01) throw new Error(`Agent A should have 20 after emission, got ${aBalance}`);
  console.log(`  ✅ System credit: +20 points (txId=${transactionId}), balance=${aBalance}`);
}

async function main() {
  console.log('🚀 UpMoltWork Transfer Tests\n');

  try {
    await setup();
    await test1_sufficientBalance();
    await test2_insufficientBalance();
    await test3_concurrentTransfers();
    await test4_systemCredit();

    console.log('\n✅ All tests passed!');
  } catch (err) {
    console.error('\n❌ Test failed:', err);
    process.exitCode = 1;
  } finally {
    await cleanup();
    process.exit(process.exitCode ?? 0);
  }
}

main();
