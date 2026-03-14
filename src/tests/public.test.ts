/**
 * Public API integration tests — validates:
 *
 *   Test 1: Feed returns USDC price fields (price_usdc, payment_mode, escrow_tx_hash)
 *   Test 2: Feed returns Shells price fields (price_points, payment_mode)
 *   Test 3: Stats 3-currency breakdown (currencies.shells, usdc_sepolia, usdc_mainnet)
 *   Test 4: Stats Shells supply equals actual sum of agent balances (excl agt_system)
 *
 * Run:     npx tsx src/tests/public.test.ts
 * Requires: DATABASE_URL in .env
 */

import 'dotenv/config';
import { eq, ne, sql } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { Hono } from 'hono';
import { db, initPool } from '../db/pool.js';
import { agents, tasks, x402Payments } from '../db/schema/index.js';
import { generateTaskId } from '../lib/ids.js';
import { publicRouter } from '../routes/public.js';
import { BASE_NETWORK } from '../lib/x402.js';

// ---------------------------------------------------------------------------
// Test Agent IDs — must be exactly 12 chars
//   pub_buyer001 = p(1)u(2)b(3)_(4)b(5)u(6)y(7)e(8)r(9)0(10)0(11)1(12) = 12 ✓
//   pub_exec0001 = p(1)u(2)b(3)_(4)e(5)x(6)e(7)c(8)0(9)0(10)0(11)1(12) = 12 ✓
// ---------------------------------------------------------------------------
const BUYER_ID = 'pub_buyer001';
const EXEC_ID  = 'pub_exec0001';

const BUYER_KEY = `axe_${BUYER_ID}_${'d'.repeat(64)}`;
const EXEC_KEY  = `axe_${EXEC_ID}_${'e'.repeat(64)}`;

let buyerKeyHash = '';
let execKeyHash  = '';

// ---------------------------------------------------------------------------
// Test Hono app
// ---------------------------------------------------------------------------

const testApp = new Hono();
testApp.route('/v1/public', publicRouter);

// ---------------------------------------------------------------------------
// Task IDs (set during setup, used across tests)
// ---------------------------------------------------------------------------
let usdcTaskId = '';
let pointsTaskId = '';

// ---------------------------------------------------------------------------
// Setup / Cleanup
// ---------------------------------------------------------------------------

const TEST_TWITTERS = ['pub_buyer_test', 'pub_exec_test'] as const;

async function cleanupData() {
  // Delete x402_payments for our tasks
  await db.execute(sql`
    DELETE FROM x402_payments
    WHERE task_id IN (
      SELECT id FROM tasks WHERE creator_agent_id IN (${BUYER_ID}, ${EXEC_ID})
    )
  `);

  // Delete tasks
  await db.execute(sql`
    DELETE FROM tasks WHERE creator_agent_id IN (${BUYER_ID}, ${EXEC_ID})
      OR executor_agent_id IN (${BUYER_ID}, ${EXEC_ID})
  `);

  // Delete tasks by twitter handle (handles partial/failed runs)
  await db.execute(sql`
    DELETE FROM tasks WHERE creator_agent_id IN (
      SELECT id FROM agents WHERE owner_twitter IN (${TEST_TWITTERS[0]}, ${TEST_TWITTERS[1]})
    )
  `);

  // Delete agents
  await db.execute(sql`
    DELETE FROM agents
    WHERE id IN (${BUYER_ID}, ${EXEC_ID})
       OR owner_twitter IN (${TEST_TWITTERS[0]}, ${TEST_TWITTERS[1]})
  `);
}

async function setup() {
  console.log('🔧 Setting up public test data...');

  [buyerKeyHash, execKeyHash] = await Promise.all([
    bcrypt.hash(BUYER_KEY, 4),
    bcrypt.hash(EXEC_KEY, 4),
  ]);

  await cleanupData();

  // Create test agents
  await db.insert(agents).values([
    {
      id: BUYER_ID,
      name: 'Public Test Buyer',
      ownerTwitter: TEST_TWITTERS[0],
      status: 'verified',
      balancePoints: '200',
      apiKeyHash: buyerKeyHash,
    },
    {
      id: EXEC_ID,
      name: 'Public Test Executor',
      ownerTwitter: TEST_TWITTERS[1],
      status: 'verified',
      balancePoints: '150',
      apiKeyHash: execKeyHash,
    },
  ]);

  // Create a completed USDC task (for feed price fields test)
  usdcTaskId = generateTaskId();
  const mockEscrowTxHash = `0x${'a'.repeat(24)}${Date.now().toString(16).padStart(16, '0')}test`;
  await db.insert(tasks).values({
    id: usdcTaskId,
    creatorAgentId: BUYER_ID,
    executorAgentId: EXEC_ID,
    category: 'development',
    title: 'Public Test USDC Task',
    description: 'A completed USDC task for feed price field testing',
    acceptanceCriteria: ['Complete the task'],
    priceUsdc: '0.500000',
    pricePoints: null,
    status: 'completed',
    autoAcceptFirst: false,
    maxBids: 5,
    validationRequired: false,
    paymentMode: 'usdc',
    escrowTxHash: mockEscrowTxHash,
  });

  // Insert corresponding x402_payments escrow record
  await db.insert(x402Payments).values({
    taskId: usdcTaskId,
    payerAddress: '0x' + 'b'.repeat(40),
    recipientAddress: '0x' + 'c'.repeat(40),
    amountUsdc: '0.500000',
    txHash: mockEscrowTxHash,
    network: BASE_NETWORK,
    paymentType: 'escrow',
  });

  // Create a completed points (Shells) task
  pointsTaskId = generateTaskId();
  await db.insert(tasks).values({
    id: pointsTaskId,
    creatorAgentId: BUYER_ID,
    executorAgentId: EXEC_ID,
    category: 'content',
    title: 'Public Test Points Task',
    description: 'A completed Shells task for feed price field testing',
    acceptanceCriteria: ['Deliver the content'],
    priceUsdc: null,
    pricePoints: '75.00',
    status: 'completed',
    autoAcceptFirst: false,
    maxBids: 5,
    validationRequired: false,
    paymentMode: 'points',
    escrowTxHash: null,
  });

  console.log(`  ✅ Agents created (buyer, executor)`);
  console.log(`  ✅ USDC task created: ${usdcTaskId}`);
  console.log(`  ✅ Points task created: ${pointsTaskId}`);
}

async function cleanup() {
  console.log('🧹 Cleaning up public test data...');
  await cleanupData();
  console.log('  ✅ Cleanup complete');
}

// ---------------------------------------------------------------------------
// Test 1: Feed returns USDC price fields
// ---------------------------------------------------------------------------
async function testFeedUsdcPriceFields() {
  console.log('\n📡 Test 1: Feed returns USDC price fields');

  const resp = await testApp.fetch(
    new Request('http://localhost/v1/public/feed?limit=100'),
  );

  if (resp.status !== 200) {
    throw new Error(`Expected 200, got ${resp.status}`);
  }

  const body = await resp.json() as { tasks: Record<string, unknown>[] };
  if (!Array.isArray(body.tasks)) throw new Error('Missing tasks array in feed response');

  // Find our USDC task
  const feedTask = body.tasks.find((t) => t.id === usdcTaskId);
  if (!feedTask) throw new Error(`USDC task ${usdcTaskId} not found in feed`);

  // Verify required price fields
  if (typeof feedTask.price_usdc !== 'number') {
    throw new Error(`price_usdc should be a number, got: ${typeof feedTask.price_usdc} (${feedTask.price_usdc})`);
  }
  if (Math.abs((feedTask.price_usdc as number) - 0.5) > 0.000001) {
    throw new Error(`Wrong price_usdc: ${feedTask.price_usdc}, expected 0.5`);
  }
  if (feedTask.payment_mode !== 'usdc') {
    throw new Error(`Wrong payment_mode: ${feedTask.payment_mode}, expected usdc`);
  }
  if (!feedTask.escrow_tx_hash) {
    throw new Error('escrow_tx_hash is missing from feed response');
  }
  if (typeof feedTask.escrow_tx_hash !== 'string') {
    throw new Error(`escrow_tx_hash should be a string, got: ${typeof feedTask.escrow_tx_hash}`);
  }

  console.log(`  → Task: ${feedTask.id}`);
  console.log(`  → price_usdc: ${feedTask.price_usdc}`);
  console.log(`  → payment_mode: ${feedTask.payment_mode}`);
  console.log(`  → escrow_tx_hash: ${(feedTask.escrow_tx_hash as string).slice(0, 20)}...`);
  console.log('  ✅ Feed returns price_usdc, payment_mode, escrow_tx_hash for USDC tasks');
}

// ---------------------------------------------------------------------------
// Test 2: Feed returns Shells price fields
// ---------------------------------------------------------------------------
async function testFeedShellsPriceFields() {
  console.log('\n🐚 Test 2: Feed returns Shells (points) price fields');

  const resp = await testApp.fetch(
    new Request('http://localhost/v1/public/feed?limit=100'),
  );

  if (resp.status !== 200) {
    throw new Error(`Expected 200, got ${resp.status}`);
  }

  const body = await resp.json() as { tasks: Record<string, unknown>[] };
  if (!Array.isArray(body.tasks)) throw new Error('Missing tasks array in feed response');

  // Find our points task
  const feedTask = body.tasks.find((t) => t.id === pointsTaskId);
  if (!feedTask) throw new Error(`Points task ${pointsTaskId} not found in feed`);

  // Verify price_points is present and correct
  if (typeof feedTask.price_points !== 'number') {
    throw new Error(`price_points should be a number, got: ${typeof feedTask.price_points} (${feedTask.price_points})`);
  }
  if (Math.abs((feedTask.price_points as number) - 75) > 0.01) {
    throw new Error(`Wrong price_points: ${feedTask.price_points}, expected 75`);
  }
  if (feedTask.payment_mode !== 'points') {
    throw new Error(`Wrong payment_mode: ${feedTask.payment_mode}, expected points`);
  }
  // USDC price should be null for points-only tasks
  if (feedTask.price_usdc !== null) {
    throw new Error(`price_usdc should be null for points task, got: ${feedTask.price_usdc}`);
  }
  // escrow_tx_hash should be null for points tasks
  if (feedTask.escrow_tx_hash !== null) {
    throw new Error(`escrow_tx_hash should be null for points task, got: ${feedTask.escrow_tx_hash}`);
  }

  console.log(`  → Task: ${feedTask.id}`);
  console.log(`  → price_points: ${feedTask.price_points}`);
  console.log(`  → payment_mode: ${feedTask.payment_mode}`);
  console.log(`  → price_usdc: ${feedTask.price_usdc} (null ✓)`);
  console.log('  ✅ Feed returns price_points, payment_mode for Shells tasks');
}

// ---------------------------------------------------------------------------
// Test 3: Stats 3-currency breakdown structure
// ---------------------------------------------------------------------------
async function testStats3CurrencyBreakdown() {
  console.log('\n📊 Test 3: Stats 3-currency breakdown structure');

  const resp = await testApp.fetch(
    new Request('http://localhost/v1/public/stats'),
  );

  if (resp.status !== 200) {
    throw new Error(`Expected 200, got ${resp.status}`);
  }

  const body = await resp.json() as Record<string, unknown>;

  // Verify top-level stats fields exist
  if (typeof body.agents !== 'number') throw new Error('Missing/invalid stats.agents');
  if (typeof body.tasks !== 'number')  throw new Error('Missing/invalid stats.tasks');

  // Verify currencies object exists
  if (!body.currencies || typeof body.currencies !== 'object') {
    throw new Error('Missing/invalid stats.currencies');
  }

  const currencies = body.currencies as Record<string, unknown>;

  // --- shells ---
  if (!currencies.shells || typeof currencies.shells !== 'object') {
    throw new Error('Missing stats.currencies.shells');
  }
  const shells = currencies.shells as Record<string, unknown>;

  if (typeof shells.total_supply !== 'number') {
    throw new Error(`currencies.shells.total_supply should be a number, got: ${typeof shells.total_supply}`);
  }
  if (typeof shells.total_spent !== 'number') {
    throw new Error(`currencies.shells.total_spent should be a number, got: ${typeof shells.total_spent}`);
  }
  if (typeof shells.avg_task_price !== 'number') {
    throw new Error(`currencies.shells.avg_task_price should be a number, got: ${typeof shells.avg_task_price}`);
  }

  console.log(`  → currencies.shells.total_supply: ${shells.total_supply}`);
  console.log(`  → currencies.shells.total_spent: ${shells.total_spent}`);
  console.log(`  → currencies.shells.avg_task_price: ${shells.avg_task_price}`);

  // --- usdc_sepolia ---
  if (!currencies.usdc_sepolia || typeof currencies.usdc_sepolia !== 'object') {
    throw new Error('Missing stats.currencies.usdc_sepolia');
  }
  const sepolia = currencies.usdc_sepolia as Record<string, unknown>;

  if (typeof sepolia.total_volume !== 'number') {
    throw new Error(`currencies.usdc_sepolia.total_volume should be a number, got: ${typeof sepolia.total_volume}`);
  }
  if (typeof sepolia.task_count !== 'number') {
    throw new Error(`currencies.usdc_sepolia.task_count should be a number, got: ${typeof sepolia.task_count}`);
  }
  if (typeof sepolia.unique_payers !== 'number') {
    throw new Error(`currencies.usdc_sepolia.unique_payers should be a number, got: ${typeof sepolia.unique_payers}`);
  }

  console.log(`  → currencies.usdc_sepolia.total_volume: ${sepolia.total_volume}`);
  console.log(`  → currencies.usdc_sepolia.task_count: ${sepolia.task_count}`);
  console.log(`  → currencies.usdc_sepolia.unique_payers: ${sepolia.unique_payers}`);

  // --- usdc_mainnet ---
  if (!currencies.usdc_mainnet || typeof currencies.usdc_mainnet !== 'object') {
    throw new Error('Missing stats.currencies.usdc_mainnet');
  }
  const mainnet = currencies.usdc_mainnet as Record<string, unknown>;

  if (typeof mainnet.total_volume !== 'number') {
    throw new Error(`currencies.usdc_mainnet.total_volume should be a number, got: ${typeof mainnet.total_volume}`);
  }
  if (typeof mainnet.task_count !== 'number') {
    throw new Error(`currencies.usdc_mainnet.task_count should be a number, got: ${typeof mainnet.task_count}`);
  }
  if (typeof mainnet.unique_payers !== 'number') {
    throw new Error(`currencies.usdc_mainnet.unique_payers should be a number, got: ${typeof mainnet.unique_payers}`);
  }

  console.log(`  → currencies.usdc_mainnet.total_volume: ${mainnet.total_volume}`);
  console.log(`  → currencies.usdc_mainnet.task_count: ${mainnet.task_count}`);
  console.log(`  → currencies.usdc_mainnet.unique_payers: ${mainnet.unique_payers}`);
  console.log('  ✅ Stats returns currencies.shells, usdc_sepolia, usdc_mainnet with correct structure');
}

// ---------------------------------------------------------------------------
// Test 4: Stats Shells supply equals actual DB sum (excl agt_system)
// ---------------------------------------------------------------------------
async function testStatsShellsSupply() {
  console.log('\n💎 Test 4: Stats Shells supply equals actual agent balance sum');

  // Query the actual sum from DB (mirrors what the stats endpoint does)
  const [dbSupply] = await db
    .select({ total: sql<string>`coalesce(sum(balance_points), 0)` })
    .from(agents)
    .where(ne(agents.id, 'agt_system'))
    .limit(1);

  const expectedSupply = parseFloat(String(dbSupply?.total ?? '0'));

  // Call stats endpoint
  const resp = await testApp.fetch(
    new Request('http://localhost/v1/public/stats'),
  );

  if (resp.status !== 200) {
    throw new Error(`Expected 200, got ${resp.status}`);
  }

  const body = await resp.json() as Record<string, unknown>;
  const currencies = body.currencies as Record<string, unknown>;
  const shells = currencies?.shells as Record<string, unknown>;

  if (!shells) throw new Error('Missing stats.currencies.shells');

  const reportedSupply = shells.total_supply as number;

  // The stats endpoint sum should match our direct DB query
  if (Math.abs(reportedSupply - expectedSupply) > 0.01) {
    throw new Error(
      `Shells supply mismatch: stats reports ${reportedSupply}, DB sum is ${expectedSupply}`,
    );
  }

  // Also verify top-level total_points_supply matches
  if (typeof body.total_points_supply !== 'number') {
    throw new Error('Missing stats.total_points_supply');
  }
  if (Math.abs((body.total_points_supply as number) - expectedSupply) > 0.01) {
    throw new Error(
      `total_points_supply mismatch: ${body.total_points_supply} vs DB sum ${expectedSupply}`,
    );
  }

  console.log(`  → DB sum (excl agt_system): ${expectedSupply}`);
  console.log(`  → currencies.shells.total_supply: ${reportedSupply}`);
  console.log(`  → total_points_supply: ${body.total_points_supply}`);
  console.log('  ✅ Shells supply matches actual DB sum of agent balances (excl agt_system)');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('🚀 Public API Integration Tests');
  console.log('='.repeat(50));

  await initPool();
  await setup();

  let passCount = 0;
  let failCount = 0;

  const run = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      passCount++;
    } catch (err) {
      console.error(`\n  ❌ FAILED: ${name}`);
      console.error(`     ${err instanceof Error ? err.message : String(err)}`);
      failCount++;
    }
  };

  await run('Test 1: Feed returns USDC price fields',          testFeedUsdcPriceFields);
  await run('Test 2: Feed returns Shells price fields',        testFeedShellsPriceFields);
  await run('Test 3: Stats 3-currency breakdown structure',   testStats3CurrencyBreakdown);
  await run('Test 4: Stats Shells supply matches DB sum',     testStatsShellsSupply);

  await cleanup();

  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passCount} passed, ${failCount} failed`);

  if (failCount > 0) {
    console.log('\n⚠️  Some tests failed. Review output above.');
    process.exit(1);
  } else {
    console.log('🎉 All public API tests passed!');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
