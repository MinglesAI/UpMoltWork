/**
 * Analytics endpoints integration tests — validates:
 *
 *   Test 1: GET /:agentId/analytics — full overview for new agent (zero data)
 *   Test 2: GET /:agentId/analytics — overview with fixture data (bids, transactions, tasks)
 *   Test 3: GET /:agentId/analytics/earnings — period=30d group_by=day
 *   Test 4: GET /:agentId/analytics/earnings — period=all group_by=month
 *   Test 5: GET /:agentId/analytics/earnings — invalid period → 400
 *   Test 6: GET /:agentId/analytics/bids — bid win rate breakdown
 *   Test 7: GET /:agentId/analytics — 404 for unknown agent
 *   Test 8: GET /:agentId/analytics — 401 without view token
 *
 * Run: npx tsx src/tests/analytics.test.ts
 * Requires: DATABASE_URL in .env, VIEW_TOKEN_SECRET set
 */

import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { db, initPool } from '../db/pool.js';
import { agents, tasks, bids, transactions } from '../db/schema/index.js';
import { dashboardRouter } from '../routes/dashboard.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
// Agent IDs: must be exactly 12 chars
const AGENT_ID   = 'agt_anltst01';  // analytics test agent — 12 chars ✓
const AGENT_ID2  = 'agt_anltst02';  // second agent for txn partner

const AGENT_KEY  = `axe_${AGENT_ID}_${'c'.repeat(64)}`;
const AGENT_KEY2 = `axe_${AGENT_ID2}_${'d'.repeat(64)}`;
const TEST_TWITTERS = ['anl_test_01', 'anl_test_02'] as const;

// Task IDs: 12 chars
const TASK_ID_1  = 'tsk_anl0001';  // task 1 (content, 80 pts) — 12 chars ✓
const TASK_ID_2  = 'tsk_anl0002';  // task 2 (development, 150 pts)
const TASK_ID_3  = 'tsk_anl0003';  // task 3 (content, 45 pts)

// Bid IDs: 12 chars
const BID_ID_1   = 'bid_anl0001';
const BID_ID_2   = 'bid_anl0002';
const BID_ID_3   = 'bid_anl0003';

let agentKeyHash  = '';
let agentKeyHash2 = '';

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------
const testApp = new Hono();
testApp.route('/v1/dashboard', dashboardRouter);

// ---------------------------------------------------------------------------
// Auth helper — generate view token
// ---------------------------------------------------------------------------
async function makeViewToken(agentId: string): Promise<string> {
  const secret = process.env.VIEW_TOKEN_SECRET ?? 'test-view-secret-32chars-minimum!!';
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ sub: agentId, type: 'view' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
}

// ---------------------------------------------------------------------------
// Setup / Cleanup
// ---------------------------------------------------------------------------
async function cleanupData() {
  // FK order: bids → transactions → tasks → agents
  await db.execute(sql`DELETE FROM bids WHERE agent_id IN (${AGENT_ID}, ${AGENT_ID2})`);
  await db.execute(sql`
    DELETE FROM transactions
    WHERE from_agent_id IN (${AGENT_ID}, ${AGENT_ID2})
       OR to_agent_id   IN (${AGENT_ID}, ${AGENT_ID2})
  `);
  await db.execute(sql`DELETE FROM bids WHERE task_id IN (${TASK_ID_1}, ${TASK_ID_2}, ${TASK_ID_3})`);
  await db.execute(sql`DELETE FROM tasks WHERE id IN (${TASK_ID_1}, ${TASK_ID_2}, ${TASK_ID_3})`);
  await db.execute(sql`DELETE FROM agents WHERE id IN (${AGENT_ID}, ${AGENT_ID2})`);
  await db.execute(sql`DELETE FROM agents WHERE owner_twitter IN (${TEST_TWITTERS[0]}, ${TEST_TWITTERS[1]})`);
}

async function setup() {
  console.log('🔧 Setting up analytics test fixtures...');

  [agentKeyHash, agentKeyHash2] = await Promise.all([
    bcrypt.hash(AGENT_KEY, 4),
    bcrypt.hash(AGENT_KEY2, 4),
  ]);

  await cleanupData();

  // Create agents
  await db.insert(agents).values([
    {
      id: AGENT_ID,
      name: 'Analytics Test Agent',
      ownerTwitter: TEST_TWITTERS[0],
      status: 'verified',
      balancePoints: '500',
      reputationScore: '4.2',
      tasksCompleted: 10,
      apiKeyHash: agentKeyHash,
    },
    {
      id: AGENT_ID2,
      name: 'Analytics Test Partner',
      ownerTwitter: TEST_TWITTERS[1],
      status: 'verified',
      balancePoints: '200',
      apiKeyHash: agentKeyHash2,
    },
  ]);

  // Create tasks
  await db.insert(tasks).values([
    {
      id: TASK_ID_1,
      creatorAgentId: AGENT_ID2,
      executorAgentId: AGENT_ID,
      category: 'content',
      title: 'Write blog post',
      description: 'Write a blog post about AI',
      acceptanceCriteria: ['500 words', 'SEO optimized'],
      pricePoints: '80',
      status: 'completed',
    },
    {
      id: TASK_ID_2,
      creatorAgentId: AGENT_ID2,
      executorAgentId: AGENT_ID,
      category: 'development',
      title: 'Build REST API',
      description: 'Build a REST API endpoint',
      acceptanceCriteria: ['TypeScript', 'Tests included'],
      pricePoints: '150',
      status: 'completed',
    },
    {
      id: TASK_ID_3,
      creatorAgentId: AGENT_ID,
      category: 'content',
      title: 'Write tweet thread',
      description: 'Write a tweet thread about crypto',
      acceptanceCriteria: ['10 tweets', 'Engaging'],
      pricePoints: '45',
      status: 'open',
    },
  ]);

  // Create bids
  await db.insert(bids).values([
    {
      id: BID_ID_1,
      taskId: TASK_ID_1,
      agentId: AGENT_ID,
      proposedApproach: 'I will write a compelling blog post',
      pricePoints: '75',
      status: 'accepted',
    },
    {
      id: BID_ID_2,
      taskId: TASK_ID_2,
      agentId: AGENT_ID,
      proposedApproach: 'I will build the API with full tests',
      pricePoints: '140',
      status: 'accepted',
    },
    {
      id: BID_ID_3,
      taskId: TASK_ID_3,
      agentId: AGENT_ID2,
      proposedApproach: 'I will write engaging tweets',
      pricePoints: '40',
      status: 'rejected',
    },
  ]);

  // Create transactions
  await db.insert(transactions).values([
    {
      fromAgentId: AGENT_ID2,
      toAgentId: AGENT_ID,
      amount: '80',
      currency: 'points',
      type: 'task_payment',
      taskId: TASK_ID_1,
      memo: 'Payment for task 1',
    },
    {
      fromAgentId: AGENT_ID2,
      toAgentId: AGENT_ID,
      amount: '150',
      currency: 'points',
      type: 'task_payment',
      taskId: TASK_ID_2,
      memo: 'Payment for task 2',
    },
    {
      fromAgentId: AGENT_ID,
      toAgentId: AGENT_ID2,
      amount: '45',
      currency: 'points',
      type: 'task_payment',
      taskId: TASK_ID_3,
      memo: 'Payment for task 3 (AGENT_ID spent)',
    },
    {
      fromAgentId: null,
      toAgentId: AGENT_ID,
      amount: '20',
      currency: 'points',
      type: 'validation_reward',
      memo: 'Validation reward',
    },
  ]);

  console.log('  ✅ Fixtures created (agents, tasks, bids, transactions)');
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}: ${(err as Error).message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function test1_overviewZeroData() {
  // Create a fresh agent with no data
  const blankId = 'agt_anlblnk1';
  await db.execute(sql`DELETE FROM agents WHERE id = ${blankId}`);
  await db.execute(sql`DELETE FROM agents WHERE owner_twitter = 'anl_blank_01'`);

  const blankKey = `axe_${blankId}_${'e'.repeat(64)}`;
  const blankHash = await bcrypt.hash(blankKey, 4);
  await db.insert(agents).values({
    id: blankId,
    name: 'Blank Agent',
    ownerTwitter: 'anl_blank_01',
    status: 'verified',
    balancePoints: '10',
    apiKeyHash: blankHash,
  });

  const token = await makeViewToken(blankId);
  const res = await testApp.request(`/v1/dashboard/${blankId}/analytics`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  assert(res.status === 200, `Expected 200, got ${res.status}`);
  const body = await res.json() as Record<string, unknown>;
  assert(body.agent_id === blankId, 'agent_id should match');
  assert(body.period === 'all_time', 'period should be all_time');

  const bids = body.bids as Record<string, number>;
  assert(bids.total === 0, 'total bids should be 0');
  assert(bids.win_rate === 0, 'win_rate should be 0');

  const earnings = body.earnings as Record<string, number>;
  assert(earnings.total_points_earned === 0, 'total_points_earned should be 0');
  assert(earnings.net_points === 0, 'net_points should be 0');

  const tasks = body.tasks as Record<string, number>;
  assert(tasks.created === 0, 'tasks.created should be 0');
  assert(tasks.success_rate === 0, 'success_rate should be 0');

  // Cleanup
  await db.execute(sql`DELETE FROM agents WHERE id = ${blankId}`);
}

async function test2_overviewWithData() {
  const token = await makeViewToken(AGENT_ID);
  const res = await testApp.request(`/v1/dashboard/${AGENT_ID}/analytics`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  assert(res.status === 200, `Expected 200, got ${res.status}`);
  const body = await res.json() as Record<string, unknown>;
  assert(body.agent_id === AGENT_ID, 'agent_id should match');

  const bidsData = body.bids as Record<string, number>;
  // AGENT_ID placed 2 bids (both accepted)
  assert(bidsData.total === 2, `Expected 2 total bids, got ${bidsData.total}`);
  assert(bidsData.accepted === 2, `Expected 2 accepted bids, got ${bidsData.accepted}`);
  assert(bidsData.win_rate === 1, `Expected win_rate=1.0, got ${bidsData.win_rate}`);

  const earnings = body.earnings as Record<string, number>;
  // Earned: 80 + 150 + 20 (validation) = 250; Spent: 45
  assert(earnings.total_points_earned === 250, `Expected 250 earned, got ${earnings.total_points_earned}`);
  assert(earnings.total_points_spent === 45, `Expected 45 spent, got ${earnings.total_points_spent}`);
  assert(earnings.net_points === 205, `Expected 205 net, got ${earnings.net_points}`);
  assert(earnings.validation_rewards === 20, `Expected 20 validation rewards, got ${earnings.validation_rewards}`);

  const tasksData = body.tasks as Record<string, number>;
  // AGENT_ID is executor of 2 completed tasks, creator of 1
  assert(tasksData.created === 1, `Expected 1 created, got ${tasksData.created}`);
  assert(tasksData.executed === 2, `Expected 2 executed, got ${tasksData.executed}`);
  assert(tasksData.completed === 2, `Expected 2 completed, got ${tasksData.completed}`);
  assert(tasksData.success_rate === 1, `Expected success_rate=1.0, got ${tasksData.success_rate}`);

  const rep = body.reputation as Record<string, unknown>;
  assert(rep.current === 4.2, `Expected reputation=4.2, got ${rep.current}`);
}

async function test3_earningsDefault() {
  const token = await makeViewToken(AGENT_ID);
  const res = await testApp.request(`/v1/dashboard/${AGENT_ID}/analytics/earnings?period=30d&group_by=day`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  assert(res.status === 200, `Expected 200, got ${res.status}`);
  const body = await res.json() as Record<string, unknown>;
  assert(body.period === '30d', 'period should be 30d');
  assert(body.group_by === 'day', 'group_by should be day');
  assert(Array.isArray(body.series), 'series should be an array');

  const totals = body.totals as Record<string, number>;
  // Recent transactions (all within last 30d by default)
  assert(totals.earned_points === 250, `Expected 250 earned, got ${totals.earned_points}`);
  assert(totals.spent_points === 45, `Expected 45 spent, got ${totals.spent_points}`);
  assert(totals.net_points === 205, `Expected 205 net, got ${totals.net_points}`);

  // Check series structure
  const series = body.series as Array<Record<string, unknown>>;
  if (series.length > 0) {
    const first = series[0];
    assert('date' in first, 'series entry should have date');
    assert('earned_points' in first, 'series entry should have earned_points');
    assert('spent_points' in first, 'series entry should have spent_points');
    assert('net_points' in first, 'series entry should have net_points');
    assert('earned_usdc' in first, 'series entry should have earned_usdc');
    assert('transaction_count' in first, 'series entry should have transaction_count');
  }
}

async function test4_earningsAllPeriodMonthly() {
  const token = await makeViewToken(AGENT_ID);
  const res = await testApp.request(`/v1/dashboard/${AGENT_ID}/analytics/earnings?period=all&group_by=month`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  assert(res.status === 200, `Expected 200, got ${res.status}`);
  const body = await res.json() as Record<string, unknown>;
  assert(body.period === 'all', 'period should be all');
  assert(body.group_by === 'month', 'group_by should be month');
  assert(Array.isArray(body.series), 'series should be an array');

  const totals = body.totals as Record<string, number>;
  assert(totals.earned_points >= 250, `Expected >= 250 earned (all time), got ${totals.earned_points}`);
}

async function test5_invalidPeriod() {
  const token = await makeViewToken(AGENT_ID);
  const res = await testApp.request(`/v1/dashboard/${AGENT_ID}/analytics/earnings?period=invalid`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  assert(res.status === 400, `Expected 400, got ${res.status}`);
  const body = await res.json() as Record<string, string>;
  assert(body.error === 'invalid_param', 'error should be invalid_param');
}

async function test6_bidsBreakdown() {
  const token = await makeViewToken(AGENT_ID);
  const res = await testApp.request(`/v1/dashboard/${AGENT_ID}/analytics/bids`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  assert(res.status === 200, `Expected 200, got ${res.status}`);
  const body = await res.json() as Record<string, unknown>;
  assert(Array.isArray(body.by_category), 'by_category should be an array');
  assert(Array.isArray(body.by_price_range), 'by_price_range should be an array');

  const byCategory = body.by_category as Array<Record<string, unknown>>;
  // AGENT_ID placed bids: content (1 accepted), development (1 accepted)
  const contentEntry = byCategory.find((r) => r.category === 'content');
  const devEntry = byCategory.find((r) => r.category === 'development');
  assert(!!contentEntry, 'should have content category');
  assert(!!devEntry, 'should have development category');
  assert(contentEntry!.won === 1, `content won should be 1, got ${contentEntry!.won}`);
  assert(contentEntry!.win_rate === 1, `content win_rate should be 1, got ${contentEntry!.win_rate}`);

  const byPriceRange = body.by_price_range as Array<Record<string, unknown>>;
  // bid 1: 75pts → 51-100, bid 2: 140pts → 101-200
  const range51_100 = byPriceRange.find((r) => r.range === '51-100');
  const range101_200 = byPriceRange.find((r) => r.range === '101-200');
  assert(!!range51_100, 'should have 51-100 range');
  assert(!!range101_200, 'should have 101-200 range');

  const trend = body.trend_30d as Record<string, number>;
  assert(typeof trend.win_rate === 'number', 'trend.win_rate should be a number');
  assert(typeof trend.vs_prev_30d === 'number', 'trend.vs_prev_30d should be a number');
}

async function test7_notFound() {
  const token = await makeViewToken('agt_notfound0');
  const res = await testApp.request('/v1/dashboard/agt_notfound0/analytics', {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(res.status === 404, `Expected 404, got ${res.status}`);
}

async function test8_unauthorized() {
  const res = await testApp.request(`/v1/dashboard/${AGENT_ID}/analytics`);
  assert(res.status === 401, `Expected 401, got ${res.status}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('\n🧪 Analytics endpoint tests\n');

  await initPool();
  await setup();

  await runTest('Test 1: Overview — zero data (new agent)', test1_overviewZeroData);
  await runTest('Test 2: Overview — with fixture data', test2_overviewWithData);
  await runTest('Test 3: Earnings — period=30d group_by=day', test3_earningsDefault);
  await runTest('Test 4: Earnings — period=all group_by=month', test4_earningsAllPeriodMonthly);
  await runTest('Test 5: Earnings — invalid period → 400', test5_invalidPeriod);
  await runTest('Test 6: Bids breakdown by category + price range', test6_bidsBreakdown);
  await runTest('Test 7: Overview — 404 for unknown agent', test7_notFound);
  await runTest('Test 8: Overview — 401 without token', test8_unauthorized);

  await cleanupData();

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
