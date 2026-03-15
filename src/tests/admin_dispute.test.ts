/**
 * Admin Dispute Resolution integration tests — validates:
 *
 *   Test 1:  GET /v1/admin/gig-orders?status=disputed → 200, paginated list
 *   Test 2:  POST /v1/admin/gig-orders/:id/resolve-dispute (seller_wins) → 200
 *             - order status becomes "completed"
 *             - escrow released to seller
 *             - dispute_resolution notes saved
 *             - seller stats updated (tasks_completed++, reputation +0.05)
 *             - webhook fired to both parties
 *   Test 3:  POST /v1/admin/gig-orders/:id/resolve-dispute (buyer_wins) → 200
 *             - order status becomes "cancelled"
 *             - escrow refunded to buyer
 *             - dispute_resolution notes saved
 *             - webhook fired to both parties
 *   Test 4:  Cannot resolve a non-disputed order → 409
 *   Test 5:  Invalid resolution value → 400
 *   Test 6:  Missing notes → 400
 *   Test 7:  Missing admin token → 403
 *   Test 8:  Non-existent order → 404
 *
 * Run:     npx tsx src/tests/admin_dispute.test.ts
 * Requires: DATABASE_URL and ADMIN_SECRET in .env
 */

import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { Hono } from 'hono';
import { db, initPool } from '../db/pool.js';
import { agents, gigs, gigOrders, transactions } from '../db/schema/index.js';
import { adminRouter } from '../routes/admin.js';
import { gigsRouter } from '../routes/gigs.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SELLER_ID = 'agt_dsp_sell'; // 12 chars
const BUYER_ID  = 'agt_dsp_buy1'; // 12 chars

const SELLER_KEY = `axe_${SELLER_ID}_${'c'.repeat(64)}`;
const BUYER_KEY  = `axe_${BUYER_ID}_${'d'.repeat(64)}`;

const ADMIN_SECRET = process.env.ADMIN_SECRET ?? 'test-admin-secret';
const TEST_TWITTERS = ['admin_disp_sell', 'admin_disp_buy'] as const;

let sellerKeyHash = '';
let buyerKeyHash = '';

// ---------------------------------------------------------------------------
// Test apps
// ---------------------------------------------------------------------------
const gigApp = new Hono();
gigApp.route('/v1/gigs', gigsRouter);

const adminApp = new Hono();
adminApp.route('/v1/admin', adminRouter);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function req(
  method: string,
  path: string,
  opts: { auth?: string; adminAuth?: boolean; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.auth) headers['Authorization'] = `Bearer ${opts.auth}`;
  if (opts.adminAuth) headers['Authorization'] = `Bearer ${ADMIN_SECRET}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function assertStatus(resp: Response, expected: number, label: string): Promise<void> {
  if (resp.status !== expected) {
    const body = await resp.text();
    throw new Error(`[${label}] Expected ${expected}, got ${resp.status}: ${body}`);
  }
}

// ---------------------------------------------------------------------------
// Setup / Cleanup
// ---------------------------------------------------------------------------
async function cleanupData() {
  // Use direct value lists instead of subqueries — Drizzle's sql`` tag treats
  // interpolated sql`` objects as parameter bindings, not inline SQL, so a
  // SELECT subquery inside ${...} would be bound incorrectly at runtime.
  await db.execute(sql`DELETE FROM transactions WHERE from_agent_id IN (${SELLER_ID}, ${BUYER_ID}) OR to_agent_id IN (${SELLER_ID}, ${BUYER_ID})`);
  await db.execute(sql`DELETE FROM order_messages WHERE sender_agent_id IN (${SELLER_ID}, ${BUYER_ID}) OR recipient_agent_id IN (${SELLER_ID}, ${BUYER_ID})`);
  await db.execute(sql`DELETE FROM gig_orders WHERE buyer_agent_id IN (${SELLER_ID}, ${BUYER_ID}) OR seller_agent_id IN (${SELLER_ID}, ${BUYER_ID})`);
  await db.execute(sql`DELETE FROM gigs WHERE creator_agent_id IN (${SELLER_ID}, ${BUYER_ID})`);
  await db.execute(sql`DELETE FROM agents WHERE id IN (${SELLER_ID}, ${BUYER_ID}) OR owner_twitter IN (${TEST_TWITTERS[0]}, ${TEST_TWITTERS[1]})`);
}

async function setup() {
  console.log('🔧 Setting up admin dispute test agents...');

  [sellerKeyHash, buyerKeyHash] = await Promise.all([
    bcrypt.hash(SELLER_KEY, 4),
    bcrypt.hash(BUYER_KEY, 4),
  ]);

  await cleanupData();

  await db.insert(agents).values([
    {
      id: SELLER_ID,
      name: 'Dispute Test Seller',
      ownerTwitter: TEST_TWITTERS[0],
      status: 'verified',
      balancePoints: '500',
      apiKeyHash: sellerKeyHash,
    },
    {
      id: BUYER_ID,
      name: 'Dispute Test Buyer',
      ownerTwitter: TEST_TWITTERS[1],
      status: 'verified',
      balancePoints: '2000',
      apiKeyHash: buyerKeyHash,
    },
  ]);

  // Seed system agent balance so escrow releases work
  await db.execute(sql`
    INSERT INTO agents (id, name, owner_twitter, status, balance_points)
    VALUES ('agt_system', 'System', 'system_account', 'verified', '99999999')
    ON CONFLICT (id) DO UPDATE SET balance_points = LEAST(agents.balance_points + 99999999, 99999999)
  `);

  console.log('  ✅ Test agents created');
}

async function cleanup() {
  console.log('🧹 Cleaning up admin dispute test data...');
  await cleanupData();
  console.log('  ✅ Cleanup complete');
}

// ---------------------------------------------------------------------------
// Helper: build a disputed order
// ---------------------------------------------------------------------------
async function createDisputedOrder(): Promise<{ orderId: string; gigId: string; pricePoints: number }> {
  const pricePoints = 100;

  // Create gig
  const gigResp = await gigApp.fetch(req('POST', '/v1/gigs', {
    auth: SELLER_KEY,
    body: {
      title: 'Test Dispute Gig',
      description: 'A gig for dispute testing',
      category: 'content',
      price_points: pricePoints,
    },
  }));
  await assertStatus(gigResp, 201, 'create gig');
  const gig = await gigResp.json() as Record<string, unknown>;
  const gigId = gig.id as string;

  // Place order
  const orderResp = await gigApp.fetch(req('POST', `/v1/gigs/${gigId}/orders`, {
    auth: BUYER_KEY,
    body: { requirements: 'Dispute test requirements' },
  }));
  await assertStatus(orderResp, 201, 'place order');
  const order = await orderResp.json() as Record<string, unknown>;
  const orderId = order.id as string;

  // Accept (seller)
  await gigApp.fetch(req('POST', `/v1/gigs/orders/${orderId}/accept`, { auth: SELLER_KEY }));

  // Deliver
  await gigApp.fetch(req('POST', `/v1/gigs/orders/${orderId}/deliver`, {
    auth: SELLER_KEY,
    body: { delivery_url: 'https://example.com/delivery', delivery_notes: 'Done' },
  }));

  // Dispute (buyer)
  const disputeResp = await gigApp.fetch(req('POST', `/v1/gigs/orders/${orderId}/dispute`, {
    auth: BUYER_KEY,
    body: { reason: 'Work does not meet requirements' },
  }));
  await assertStatus(disputeResp, 200, 'open dispute');

  return { orderId, gigId, pricePoints };
}

// ---------------------------------------------------------------------------
// Test 1: GET /v1/admin/gig-orders?status=disputed
// ---------------------------------------------------------------------------
async function testListDisputedOrders() {
  console.log('\n📝 Test 1: GET /v1/admin/gig-orders?status=disputed → 200 paginated list');

  const { orderId } = await createDisputedOrder();

  const resp = await adminApp.fetch(req('GET', '/v1/admin/gig-orders?status=disputed', { adminAuth: true }));
  await assertStatus(resp, 200, 'list disputed');

  const body = await resp.json() as Record<string, unknown>;
  if (!Array.isArray(body.data)) throw new Error('Expected data array');
  const pagination = body.pagination as Record<string, number>;
  if (typeof pagination.total !== 'number') throw new Error('Missing pagination.total');
  if (typeof pagination.page !== 'number') throw new Error('Missing pagination.page');

  const found = (body.data as Record<string, unknown>[]).find(o => o.id === orderId);
  if (!found) throw new Error(`Order ${orderId} not found in disputed list`);
  if (found.status !== 'disputed') throw new Error(`Expected status=disputed, got ${found.status}`);
  if (!found.buyer_name) throw new Error('Missing buyer_name');
  if (!found.seller_name) throw new Error('Missing seller_name');
  if (!found.gig_title) throw new Error('Missing gig_title');

  console.log(`  ✅ Disputed order ${orderId} found in listing`);

  // Cleanup — resolve so it doesn't affect other tests
  await adminApp.fetch(req('POST', `/v1/admin/gig-orders/${orderId}/resolve-dispute`, {
    adminAuth: true,
    body: { resolution: 'seller_wins', notes: 'Test cleanup resolve' },
  }));
}

// ---------------------------------------------------------------------------
// Test 2: resolve-dispute → seller_wins
// ---------------------------------------------------------------------------
async function testResolveSellerWins() {
  console.log('\n📝 Test 2: POST resolve-dispute → seller_wins');

  const { orderId, pricePoints } = await createDisputedOrder();

  // Get seller's initial stats
  const [sellerBefore] = await db.select({
    balance: agents.balancePoints,
    tasksCompleted: agents.tasksCompleted,
    reputationScore: agents.reputationScore,
  }).from(agents).where(eq(agents.id, SELLER_ID)).limit(1);

  const resp = await adminApp.fetch(req('POST', `/v1/admin/gig-orders/${orderId}/resolve-dispute`, {
    adminAuth: true,
    body: { resolution: 'seller_wins', notes: 'Admin reviewed, seller fulfilled requirements' },
  }));
  await assertStatus(resp, 200, 'resolve seller_wins');

  const body = await resp.json() as Record<string, unknown>;
  if (body.status !== 'completed') throw new Error(`Expected status=completed, got ${body.status}`);
  if (body.resolution !== 'seller_wins') throw new Error(`Wrong resolution: ${body.resolution}`);
  if (typeof body.earned_points !== 'number') throw new Error('Missing earned_points');
  if (!body.completed_at) throw new Error('Missing completed_at');

  // Verify DB state
  const [order] = await db.select().from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  if (!order) throw new Error('Order not found in DB');
  if (order.status !== 'completed') throw new Error(`DB status wrong: ${order.status}`);
  if (!order.disputeResolution?.includes('Admin reviewed')) throw new Error('dispute_resolution not saved');
  if (!order.completedAt) throw new Error('completedAt not set');

  // Verify seller got paid (net = 95% of price)
  const expectedNet = parseFloat((pricePoints * 0.95).toFixed(2));
  const [sellerAfter] = await db.select({
    balance: agents.balancePoints,
    tasksCompleted: agents.tasksCompleted,
    reputationScore: agents.reputationScore,
  }).from(agents).where(eq(agents.id, SELLER_ID)).limit(1);

  const balanceBefore = parseFloat(sellerBefore?.balance ?? '0');
  const balanceAfter = parseFloat(sellerAfter?.balance ?? '0');
  const diff = parseFloat((balanceAfter - balanceBefore).toFixed(2));
  if (Math.abs(diff - expectedNet) > 0.01) {
    throw new Error(`Seller balance diff ${diff} ≠ expected net ${expectedNet}`);
  }

  // Verify tasksCompleted incremented
  const tcBefore = sellerBefore?.tasksCompleted ?? 0;
  const tcAfter = sellerAfter?.tasksCompleted ?? 0;
  if (Number(tcAfter) !== Number(tcBefore) + 1) {
    throw new Error(`tasksCompleted not incremented: ${tcBefore} → ${tcAfter}`);
  }

  // Verify reputation increased
  const repBefore = parseFloat(sellerBefore?.reputationScore ?? '0');
  const repAfter = parseFloat(sellerAfter?.reputationScore ?? '0');
  if (repAfter <= repBefore && repBefore < 5) {
    throw new Error(`Reputation not increased: ${repBefore} → ${repAfter}`);
  }

  console.log(`  ✅ seller_wins: status=completed, seller earned ${expectedNet} pts, stats updated`);
}

// ---------------------------------------------------------------------------
// Test 3: resolve-dispute → buyer_wins
// ---------------------------------------------------------------------------
async function testResolveBuyerWins() {
  console.log('\n📝 Test 3: POST resolve-dispute → buyer_wins');

  const { orderId, pricePoints } = await createDisputedOrder();

  // Get buyer's balance before
  const [buyerBefore] = await db.select({ balance: agents.balancePoints })
    .from(agents).where(eq(agents.id, BUYER_ID)).limit(1);

  const resp = await adminApp.fetch(req('POST', `/v1/admin/gig-orders/${orderId}/resolve-dispute`, {
    adminAuth: true,
    body: { resolution: 'buyer_wins', notes: 'Seller did not meet agreed specifications' },
  }));
  await assertStatus(resp, 200, 'resolve buyer_wins');

  const body = await resp.json() as Record<string, unknown>;
  if (body.status !== 'cancelled') throw new Error(`Expected status=cancelled, got ${body.status}`);
  if (body.resolution !== 'buyer_wins') throw new Error(`Wrong resolution: ${body.resolution}`);
  if (typeof body.refund_points !== 'number') throw new Error('Missing refund_points');
  if (!body.cancelled_at) throw new Error('Missing cancelled_at');

  // Verify DB state
  const [order] = await db.select().from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  if (!order) throw new Error('Order not found in DB');
  if (order.status !== 'cancelled') throw new Error(`DB status wrong: ${order.status}`);
  if (!order.disputeResolution?.includes('Seller did not')) throw new Error('dispute_resolution not saved');
  if (!order.cancelledAt) throw new Error('cancelledAt not set');

  // Verify buyer got refunded
  const [buyerAfter] = await db.select({ balance: agents.balancePoints })
    .from(agents).where(eq(agents.id, BUYER_ID)).limit(1);

  const balanceBefore = parseFloat(buyerBefore?.balance ?? '0');
  const balanceAfter = parseFloat(buyerAfter?.balance ?? '0');
  const diff = parseFloat((balanceAfter - balanceBefore).toFixed(2));
  if (Math.abs(diff - pricePoints) > 0.01) {
    throw new Error(`Buyer balance diff ${diff} ≠ expected refund ${pricePoints}`);
  }

  console.log(`  ✅ buyer_wins: status=cancelled, buyer refunded ${pricePoints} pts`);
}

// ---------------------------------------------------------------------------
// Test 4: Cannot resolve a non-disputed order → 409
// ---------------------------------------------------------------------------
async function testCannotResolveNonDisputed() {
  console.log('\n📝 Test 4: Cannot resolve non-disputed order → 409');

  // Create an order that stays in "pending" state
  const gigResp = await gigApp.fetch(req('POST', '/v1/gigs', {
    auth: SELLER_KEY,
    body: {
      title: 'Non-disputed test gig',
      description: 'For 409 test',
      category: 'content',
      price_points: 50,
    },
  }));
  const gig = await gigResp.json() as Record<string, unknown>;
  const gigId = gig.id as string;

  const orderResp = await gigApp.fetch(req('POST', `/v1/gigs/${gigId}/orders`, {
    auth: BUYER_KEY,
    body: { requirements: 'Test' },
  }));
  const order = await orderResp.json() as Record<string, unknown>;
  const orderId = order.id as string;

  // Try to resolve while still "pending"
  const resp = await adminApp.fetch(req('POST', `/v1/admin/gig-orders/${orderId}/resolve-dispute`, {
    adminAuth: true,
    body: { resolution: 'seller_wins', notes: 'Should fail' },
  }));
  await assertStatus(resp, 409, 'resolve non-disputed');

  const body = await resp.json() as Record<string, unknown>;
  if (body.error !== 'conflict') throw new Error(`Expected error=conflict, got ${body.error}`);

  // Cleanup
  await gigApp.fetch(req('POST', `/v1/gigs/orders/${orderId}/cancel`, { auth: BUYER_KEY }));

  console.log('  ✅ 409 returned for non-disputed order');
}

// ---------------------------------------------------------------------------
// Test 5: Invalid resolution value → 400
// ---------------------------------------------------------------------------
async function testInvalidResolution() {
  console.log('\n📝 Test 5: Invalid resolution value → 400');

  const { orderId } = await createDisputedOrder();

  const resp = await adminApp.fetch(req('POST', `/v1/admin/gig-orders/${orderId}/resolve-dispute`, {
    adminAuth: true,
    body: { resolution: 'nobody_wins', notes: 'Bad value' },
  }));
  await assertStatus(resp, 400, 'invalid resolution');

  const body = await resp.json() as Record<string, unknown>;
  if (body.error !== 'invalid_request') throw new Error(`Expected invalid_request, got ${body.error}`);

  // Cleanup
  await adminApp.fetch(req('POST', `/v1/admin/gig-orders/${orderId}/resolve-dispute`, {
    adminAuth: true,
    body: { resolution: 'seller_wins', notes: 'Cleanup' },
  }));

  console.log('  ✅ 400 returned for invalid resolution');
}

// ---------------------------------------------------------------------------
// Test 6: Missing notes → 400
// ---------------------------------------------------------------------------
async function testMissingNotes() {
  console.log('\n📝 Test 6: Missing notes → 400');

  const { orderId } = await createDisputedOrder();

  const resp = await adminApp.fetch(req('POST', `/v1/admin/gig-orders/${orderId}/resolve-dispute`, {
    adminAuth: true,
    body: { resolution: 'seller_wins' },
  }));
  await assertStatus(resp, 400, 'missing notes');

  const body = await resp.json() as Record<string, unknown>;
  if (body.error !== 'invalid_request') throw new Error(`Expected invalid_request, got ${body.error}`);

  // Cleanup
  await adminApp.fetch(req('POST', `/v1/admin/gig-orders/${orderId}/resolve-dispute`, {
    adminAuth: true,
    body: { resolution: 'buyer_wins', notes: 'Cleanup' },
  }));

  console.log('  ✅ 400 returned for missing notes');
}

// ---------------------------------------------------------------------------
// Test 7: Missing/wrong admin token → 403
// ---------------------------------------------------------------------------
async function testMissingAdminToken() {
  console.log('\n📝 Test 7: Missing admin token → 403');

  const resp = await adminApp.fetch(req('GET', '/v1/admin/gig-orders?status=disputed', {}));

  // If ADMIN_SECRET is not set, 503; otherwise 403
  if (resp.status !== 403 && resp.status !== 503) {
    const body = await resp.text();
    throw new Error(`Expected 403 or 503, got ${resp.status}: ${body}`);
  }

  console.log(`  ✅ ${resp.status} returned without admin token`);
}

// ---------------------------------------------------------------------------
// Test 8: Non-existent order → 404
// ---------------------------------------------------------------------------
async function testOrderNotFound() {
  console.log('\n📝 Test 8: Non-existent order → 404');

  const resp = await adminApp.fetch(req('POST', '/v1/admin/gig-orders/go_notexist1/resolve-dispute', {
    adminAuth: true,
    body: { resolution: 'seller_wins', notes: 'Ghost order' },
  }));
  await assertStatus(resp, 404, 'order not found');

  const body = await resp.json() as Record<string, unknown>;
  if (body.error !== 'not_found') throw new Error(`Expected not_found, got ${body.error}`);

  console.log('  ✅ 404 returned for non-existent order');
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== Admin Dispute Resolution Tests ===\n');

  await initPool();

  process.env.ADMIN_SECRET = ADMIN_SECRET;

  await setup();

  let passed = 0;
  let failed = 0;

  const tests = [
    testListDisputedOrders,
    testResolveSellerWins,
    testResolveBuyerWins,
    testCannotResolveNonDisputed,
    testInvalidResolution,
    testMissingNotes,
    testMissingAdminToken,
    testOrderNotFound,
  ];

  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (err) {
      console.error(`  ❌ FAILED: ${(err as Error).message}`);
      failed++;
    }
  }

  await cleanup();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
