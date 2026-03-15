/**
 * Timeout Service Tests
 *
 * Tests all 5 timeout scenarios:
 *   1. pending gig order → cancelled (buyer refund) after 48h
 *   2. accepted gig order → cancelled (buyer refund + seller rep -0.1) after delivery_days+2
 *   3. delivered gig order → completed (auto-accept + seller rep +0.05) after 7 days
 *   4. revision_requested gig order → cancelled (buyer refund) after 72h
 *   5. in_progress task → open (executor removed + rep -0.1) after deadline+24h
 *
 * Run:     npx tsx src/tests/timeout.test.ts
 * Requires: DATABASE_URL in .env
 */

import 'dotenv/config';
import { eq, and, sql } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { db, initPool } from '../db/pool.js';
import { agents, bids, gigs, gigOrders, tasks, transactions } from '../db/schema/index.js';
import {
  runOrderTimeouts,
  runTaskTimeouts,
  runDeadlineWarnings,
  TIMEOUTS,
} from '../services/timeoutService.js';

// ---------------------------------------------------------------------------
// Test agent IDs (12-char padded to exact length)
// ---------------------------------------------------------------------------
const TO_SELLER = 'agt_to_sell1';  // 12 chars
const TO_BUYER  = 'agt_to_buy01';  // 12 chars
const TO_EXEC   = 'agt_to_exec1';  // 12 chars
const TO_POSTER = 'agt_to_post1';  // 12 chars

// API key stubs (not used for HTTP in this test — only hashed for DB insert)
const SELLER_KEY = `axe_${TO_SELLER}_${'c'.repeat(64)}`;
const BUYER_KEY  = `axe_${TO_BUYER}_${'d'.repeat(64)}`;
const EXEC_KEY   = `axe_${TO_EXEC}_${'e'.repeat(64)}`;
const POSTER_KEY = `axe_${TO_POSTER}_${'f'.repeat(64)}`;

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error('    ', err instanceof Error ? err.message : err);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Setup / Cleanup
// ---------------------------------------------------------------------------

async function setup(): Promise<void> {
  console.log('🔧 Setting up timeout test agents...');

  const [sh, bh, eh, ph] = await Promise.all([
    bcrypt.hash(SELLER_KEY, 4),
    bcrypt.hash(BUYER_KEY, 4),
    bcrypt.hash(EXEC_KEY, 4),
    bcrypt.hash(POSTER_KEY, 4),
  ]);

  await cleanupData();

  await db.insert(agents).values([
    { id: TO_SELLER, name: 'TO Seller',  ownerTwitter: 'to_seller_test',  status: 'verified', balancePoints: '100',  apiKeyHash: sh },
    { id: TO_BUYER,  name: 'TO Buyer',   ownerTwitter: 'to_buyer_test',   status: 'verified', balancePoints: '5000', apiKeyHash: bh },
    { id: TO_EXEC,   name: 'TO Exec',    ownerTwitter: 'to_exec_test',    status: 'verified', balancePoints: '100',  apiKeyHash: eh },
    { id: TO_POSTER, name: 'TO Poster',  ownerTwitter: 'to_poster_test',  status: 'verified', balancePoints: '1000', apiKeyHash: ph },
  ]);

  // Seed escrow for system agent (needed for refund / release)
  const [sys] = await db
    .select({ id: agents.id, balance: agents.balancePoints })
    .from(agents)
    .where(eq(agents.id, 'agt_system'))
    .limit(1);

  if (!sys) {
    // Create system agent if not present (test DB may not have it)
    await db.insert(agents).values({
      id: 'agt_system',
      name: 'System',
      ownerTwitter: 'system_agt',
      status: 'verified',
      balancePoints: '99999',
      apiKeyHash: 'dummy',
    }).onConflictDoNothing();
  }

  console.log('  ✅ Timeout test agents ready');
}

async function cleanupData(): Promise<void> {
  const testAgentIds = [TO_SELLER, TO_BUYER, TO_EXEC, TO_POSTER];

  // Delete bids, transactions, orders, gigs, tasks created by test agents
  for (const aid of testAgentIds) {
    await db.execute(sql`DELETE FROM transactions WHERE from_agent_id = ${aid} OR to_agent_id = ${aid}`);
    await db.execute(sql`DELETE FROM bids WHERE agent_id = ${aid}`);
    await db.execute(sql`
      DELETE FROM gig_orders
      WHERE buyer_agent_id = ${aid} OR seller_agent_id = ${aid}
    `);
    await db.execute(sql`DELETE FROM gigs WHERE creator_agent_id = ${aid}`);
    await db.execute(sql`
      DELETE FROM tasks
      WHERE creator_agent_id = ${aid} OR executor_agent_id = ${aid}
    `);
    await db.execute(sql`DELETE FROM agents WHERE id = ${aid}`);
  }
}

// ---------------------------------------------------------------------------
// Helper: create gig + order in a specific status with backdated timestamps
// ---------------------------------------------------------------------------

async function insertGig(deliveryDays: number = 3): Promise<string> {
  const gigId = `gig_to${Math.random().toString(36).slice(2, 7)}`;
  await db.insert(gigs).values({
    id: gigId,
    creatorAgentId: TO_SELLER,
    title: 'Test Timeout Gig',
    description: 'For timeout tests',
    category: 'development',
    pricePoints: '100',
    deliveryDays,
    status: 'open',
  });
  return gigId;
}

async function insertOrder(opts: {
  gigId: string;
  status: string;
  createdAt?: Date;
  acceptedAt?: Date;
  deliveredAt?: Date;
  updatedAt?: Date;
}): Promise<string> {
  const orderId = `go_to${Math.random().toString(36).slice(2, 7)}`;

  // Insert with defaultNow, then manually update timestamps
  await db.insert(gigOrders).values({
    id: orderId,
    gigId: opts.gigId,
    buyerAgentId: TO_BUYER,
    sellerAgentId: TO_SELLER,
    pricePoints: '100',
    paymentMode: 'points',
    status: opts.status,
    acceptedAt: opts.acceptedAt ?? null,
    deliveredAt: opts.deliveredAt ?? null,
    completedAt: null,
    cancelledAt: null,
  });

  // Use raw SQL to override timestamp columns
  if (opts.createdAt) {
    await db.execute(sql`UPDATE gig_orders SET created_at = ${opts.createdAt} WHERE id = ${orderId}`);
  }
  if (opts.updatedAt) {
    await db.execute(sql`UPDATE gig_orders SET updated_at = ${opts.updatedAt} WHERE id = ${orderId}`);
  }

  // Credit system escrow (simulate buyer having paid)
  await db.execute(sql`UPDATE agents SET balance_points = balance_points - 100 WHERE id = ${TO_BUYER}`);
  await db.execute(sql`UPDATE agents SET balance_points = balance_points + 100 WHERE id = 'agt_system'`);

  return orderId;
}

async function insertTask(opts: {
  status: string;
  executorAgentId: string | null;
  deadline?: Date | null;
  createdAt?: Date;
}): Promise<string> {
  const taskId = `tsk_to${Math.random().toString(36).slice(2, 7)}`;

  await db.insert(tasks).values({
    id: taskId,
    creatorAgentId: TO_POSTER,
    title: 'Test Timeout Task',
    description: 'For timeout tests',
    acceptanceCriteria: ['criterion 1'],
    category: 'development',
    pricePoints: '50',
    paymentMode: 'points',
    status: opts.status,
    executorAgentId: opts.executorAgentId,
    deadline: opts.deadline ?? null,
  });

  if (opts.createdAt) {
    await db.execute(sql`UPDATE tasks SET created_at = ${opts.createdAt} WHERE id = ${taskId}`);
  }

  return taskId;
}

// ---------------------------------------------------------------------------
// Test: 1 — pending order timeout (48h)
// ---------------------------------------------------------------------------

async function testPendingOrderTimeout(): Promise<void> {
  const gigId = await insertGig();
  const oldCreatedAt = new Date(Date.now() - 49 * 3600_000); // 49h ago
  const orderId = await insertOrder({ gigId, status: 'pending', createdAt: oldCreatedAt });

  const [buyerBefore] = await db.select({ bal: agents.balancePoints }).from(agents).where(eq(agents.id, TO_BUYER)).limit(1);

  await runOrderTimeouts();

  const [order] = await db.select({ status: gigOrders.status }).from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  assert(order?.status === 'cancelled', `Order should be cancelled, got: ${order?.status}`);

  const [buyerAfter] = await db.select({ bal: agents.balancePoints }).from(agents).where(eq(agents.id, TO_BUYER)).limit(1);
  const refunded = parseFloat(buyerAfter?.bal ?? '0') - parseFloat(buyerBefore?.bal ?? '0');
  assert(refunded === 100, `Buyer should be refunded 100 points, got: ${refunded}`);
}

// ---------------------------------------------------------------------------
// Test: 2 — accepted order timeout (delivery_days + 2)
// ---------------------------------------------------------------------------

async function testAcceptedOrderTimeout(): Promise<void> {
  const gigId = await insertGig(3); // delivery_days = 3, so timeout = 5 days
  // accepted 6 days ago → expired
  const acceptedAt = new Date(Date.now() - 6 * 86_400_000);
  const orderId = await insertOrder({ gigId, status: 'accepted', acceptedAt });

  const [sellerBefore] = await db.select({ rep: agents.reputationScore }).from(agents).where(eq(agents.id, TO_SELLER)).limit(1);

  await runOrderTimeouts();

  const [order] = await db.select({ status: gigOrders.status }).from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  assert(order?.status === 'cancelled', `Order should be cancelled, got: ${order?.status}`);

  const [sellerAfter] = await db.select({ rep: agents.reputationScore }).from(agents).where(eq(agents.id, TO_SELLER)).limit(1);
  const repDelta = parseFloat(sellerAfter?.rep ?? '0') - parseFloat(sellerBefore?.rep ?? '0');
  assert(Math.abs(repDelta - (-0.1)) < 0.001, `Seller rep delta should be -0.1, got: ${repDelta}`);
}

// ---------------------------------------------------------------------------
// Test: 3 — delivered order auto-complete after 7 days
// ---------------------------------------------------------------------------

async function testDeliveredOrderAutoComplete(): Promise<void> {
  const gigId = await insertGig();
  const deliveredAt = new Date(Date.now() - 8 * 86_400_000); // 8 days ago
  const orderId = await insertOrder({ gigId, status: 'delivered', deliveredAt });

  const [sellerBefore] = await db.select({ rep: agents.reputationScore, tc: agents.tasksCompleted }).from(agents).where(eq(agents.id, TO_SELLER)).limit(1);

  await runOrderTimeouts();

  const [order] = await db.select({ status: gigOrders.status }).from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  assert(order?.status === 'completed', `Order should be completed, got: ${order?.status}`);

  const [sellerAfter] = await db.select({ rep: agents.reputationScore, tc: agents.tasksCompleted }).from(agents).where(eq(agents.id, TO_SELLER)).limit(1);
  const repDelta = parseFloat(sellerAfter?.rep ?? '0') - parseFloat(sellerBefore?.rep ?? '0');
  assert(Math.abs(repDelta - 0.05) < 0.001, `Seller rep delta should be +0.05, got: ${repDelta}`);
  const tcDelta = (sellerAfter?.tc ?? 0) - (sellerBefore?.tc ?? 0);
  assert(tcDelta === 1, `Seller tasksCompleted should increase by 1, got delta: ${tcDelta}`);
}

// ---------------------------------------------------------------------------
// Test: 4 — revision_requested order timeout (72h)
// ---------------------------------------------------------------------------

async function testRevisionOrderTimeout(): Promise<void> {
  const gigId = await insertGig();
  const updatedAt = new Date(Date.now() - 73 * 3600_000); // 73h ago
  const orderId = await insertOrder({ gigId, status: 'revision_requested', updatedAt });

  const [buyerBefore] = await db.select({ bal: agents.balancePoints }).from(agents).where(eq(agents.id, TO_BUYER)).limit(1);

  await runOrderTimeouts();

  const [order] = await db.select({ status: gigOrders.status }).from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  assert(order?.status === 'cancelled', `Order should be cancelled, got: ${order?.status}`);

  const [buyerAfter] = await db.select({ bal: agents.balancePoints }).from(agents).where(eq(agents.id, TO_BUYER)).limit(1);
  const refunded = parseFloat(buyerAfter?.bal ?? '0') - parseFloat(buyerBefore?.bal ?? '0');
  assert(refunded === 100, `Buyer should be refunded 100 points, got: ${refunded}`);
}

// ---------------------------------------------------------------------------
// Test: 5 — in_progress task executor timeout (deadline + 24h)
// ---------------------------------------------------------------------------

async function testTaskExecutorTimeout(): Promise<void> {
  // Deadline was 2 days ago, buffer 24h → should have timed out yesterday
  const deadline = new Date(Date.now() - 2 * 86_400_000);
  const taskId = await insertTask({ status: 'in_progress', executorAgentId: TO_EXEC, deadline });

  // Add a bid from executor so we can verify it's rejected
  const bidId = `bid_to${Math.random().toString(36).slice(2, 7)}`;
  await db.insert(bids).values({
    id: bidId,
    taskId,
    agentId: TO_EXEC,
    proposedApproach: 'I will do this',
    status: 'accepted',
  });

  const [execBefore] = await db.select({ rep: agents.reputationScore }).from(agents).where(eq(agents.id, TO_EXEC)).limit(1);

  await runTaskTimeouts();

  const [task] = await db.select({ status: tasks.status, exec: tasks.executorAgentId }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  assert(task?.status === 'open', `Task should be open, got: ${task?.status}`);
  assert(task?.exec === null, `Executor should be null, got: ${task?.exec}`);

  const [bid] = await db.select({ status: bids.status }).from(bids).where(eq(bids.id, bidId)).limit(1);
  assert(bid?.status === 'rejected', `Bid should be rejected, got: ${bid?.status}`);

  const [execAfter] = await db.select({ rep: agents.reputationScore }).from(agents).where(eq(agents.id, TO_EXEC)).limit(1);
  const repDelta = parseFloat(execAfter?.rep ?? '0') - parseFloat(execBefore?.rep ?? '0');
  assert(Math.abs(repDelta - (-0.1)) < 0.001, `Exec rep delta should be -0.1, got: ${repDelta}`);
}

// ---------------------------------------------------------------------------
// Test: 6 — task with no deadline uses created_at + 7 days
// ---------------------------------------------------------------------------

async function testTaskNoDeadlineTimeout(): Promise<void> {
  const createdAt = new Date(Date.now() - 8 * 86_400_000); // 8 days ago, no deadline
  const taskId = await insertTask({ status: 'in_progress', executorAgentId: TO_EXEC, deadline: null, createdAt });

  await runTaskTimeouts();

  const [task] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  assert(task?.status === 'open', `Task with no deadline should time out after 7 days. Status: ${task?.status}`);
}

// ---------------------------------------------------------------------------
// Test: 7 — non-expired pending order is NOT cancelled
// ---------------------------------------------------------------------------

async function testPendingOrderNotExpired(): Promise<void> {
  const gigId = await insertGig();
  const recentCreatedAt = new Date(Date.now() - 10 * 3600_000); // 10h ago, not expired
  const orderId = await insertOrder({ gigId, status: 'pending', createdAt: recentCreatedAt });

  await runOrderTimeouts();

  const [order] = await db.select({ status: gigOrders.status }).from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  assert(order?.status === 'pending', `Non-expired order should remain pending, got: ${order?.status}`);

  // Cleanup: manually cancel and refund so we don't pollute later tests
  await db.execute(sql`UPDATE gig_orders SET status = 'cancelled' WHERE id = ${orderId}`);
  await db.execute(sql`UPDATE agents SET balance_points = balance_points + 100 WHERE id = ${TO_BUYER}`);
  await db.execute(sql`UPDATE agents SET balance_points = balance_points - 100 WHERE id = 'agt_system'`);
}

// ---------------------------------------------------------------------------
// Test: 8 — runDeadlineWarnings doesn't crash
// ---------------------------------------------------------------------------

async function testWarningsNoCrash(): Promise<void> {
  // Just verify no unhandled errors
  await runDeadlineWarnings();
}

// ---------------------------------------------------------------------------
// Test: 9 — TIMEOUTS config reads env vars
// ---------------------------------------------------------------------------

async function testTimeoutsConfig(): Promise<void> {
  // Default values
  assert(TIMEOUTS.gigPendingHours() === 48, `Default gigPendingHours should be 48`);
  assert(TIMEOUTS.gigAcceptedBufferDays() === 2, `Default gigAcceptedBufferDays should be 2`);
  assert(TIMEOUTS.gigDeliveredDays() === 7, `Default gigDeliveredDays should be 7`);
  assert(TIMEOUTS.gigRevisionHours() === 72, `Default gigRevisionHours should be 72`);
  assert(TIMEOUTS.taskBufferHours() === 24, `Default taskBufferHours should be 24`);
  assert(TIMEOUTS.taskNoDeadlineDays() === 7, `Default taskNoDeadlineDays should be 7`);
  assert(TIMEOUTS.warningHours() === 24, `Default warningHours should be 24`);

  // Override via env
  process.env.TIMEOUT_GIG_PENDING_HOURS = '96';
  assert(TIMEOUTS.gigPendingHours() === 96, `Override gigPendingHours should be 96`);
  delete process.env.TIMEOUT_GIG_PENDING_HOURS;
  assert(TIMEOUTS.gigPendingHours() === 48, `After delete, gigPendingHours should return to 48`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await initPool();
  await setup();

  console.log('\n📋 Running timeout service tests...\n');

  await runTest('1. pending order cancels after 48h (with refund)', testPendingOrderTimeout);
  await runTest('2. accepted order cancels after delivery_days+2 (seller rep -0.1)', testAcceptedOrderTimeout);
  await runTest('3. delivered order auto-completes after 7 days (seller rep +0.05)', testDeliveredOrderAutoComplete);
  await runTest('4. revision_requested order cancels after 72h (with refund)', testRevisionOrderTimeout);
  await runTest('5. in_progress task times out after deadline+24h (executor removed)', testTaskExecutorTimeout);
  await runTest('6. task with no deadline times out after 7 days', testTaskNoDeadlineTimeout);
  await runTest('7. non-expired pending order is NOT cancelled', testPendingOrderNotExpired);
  await runTest('8. runDeadlineWarnings does not crash', testWarningsNoCrash);
  await runTest('9. TIMEOUTS config reads env vars correctly', testTimeoutsConfig);

  console.log('\n🧹 Cleaning up...');
  await cleanupData();

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
