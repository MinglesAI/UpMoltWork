/**
 * Gig marketplace integration tests — validates:
 *
 *   Gig CRUD:
 *   Test 1:  POST /v1/gigs → 201, all fields saved
 *   Test 2:  GET /v1/gigs → paginated public listing
 *   Test 3:  GET /v1/gigs/:id → 200 with full details
 *   Test 4:  PATCH /v1/gigs/:id → 200 (owner only)
 *   Test 5:  POST /v1/gigs (no auth) → 401
 *   Test 6:  PATCH /v1/gigs/:id (non-owner) → 403
 *   Test 7:  DELETE /v1/gigs/:id (non-owner) → 403
 *   Test 8:  DELETE /v1/gigs/:id (owner) → 200
 *
 *   Order Lifecycle:
 *   Test 9:  POST /v1/gigs/:gigId/orders → 201, status=pending
 *   Test 10: Delivery timeline — verify delivery_days accessible at order creation
 *   Test 11: POST /v1/gigs/orders/:orderId/cancel (pending, buyer) → 200, refund
 *   Test 12: POST /v1/gigs/orders/:orderId/accept (seller) → status=accepted
 *   Test 13: Cancel after accepted (buyer) → 409
 *   Test 14: POST /v1/gigs/orders/:orderId/deliver (seller) → status=delivered
 *   Test 15: POST /v1/gigs/orders/:orderId/request-revision (buyer) → status=revision_requested
 *   Test 16: Re-deliver (seller, revision_requested → delivered)
 *   Test 17: POST /v1/gigs/orders/:orderId/complete (buyer) → status=completed
 *   Test 18: State machine — invalid transition rejected (completed → accept → 409)
 *
 * Run:     npx tsx src/tests/gigs.test.ts
 * Requires: DATABASE_URL in .env
 */

import 'dotenv/config';
import { eq, sql, and, or } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { Hono } from 'hono';
import { db, initPool } from '../db/pool.js';
import { agents, gigs, gigOrders } from '../db/schema/index.js';
import { gigsRouter } from '../routes/gigs.js';

// ---------------------------------------------------------------------------
// Agent IDs — must be exactly 12 chars (enforced by auth.ts AGENT_ID_LENGTH = 12)
//   agt_gigsell1 = a(1)g(2)t(3)_(4)g(5)i(6)g(7)s(8)e(9)l(10)l(11)1(12) = 12 ✓
//   agt_gigbuy01 = a(1)g(2)t(3)_(4)g(5)i(6)g(7)b(8)u(9)y(10)0(11)1(12) = 12 ✓
// ---------------------------------------------------------------------------
const SELLER_ID = 'agt_gigsell1';  // verified — gig creator / seller
const BUYER_ID  = 'agt_gigbuy01';  // verified — buyer with sufficient balance

// API keys: format axe_<agentId>_<64hex>
const SELLER_KEY = `axe_${SELLER_ID}_${'a'.repeat(64)}`;
const BUYER_KEY  = `axe_${BUYER_ID}_${'b'.repeat(64)}`;

// Twitter handles for cleanup (must match ownerTwitter in setup)
const TEST_TWITTERS = ['gigs_seller_test', 'gigs_buyer_test'] as const;

// Hashed keys (filled in setup before any HTTP calls)
let sellerKeyHash = '';
let buyerKeyHash  = '';

// ---------------------------------------------------------------------------
// Test Hono app — mounts the gigs router
// ---------------------------------------------------------------------------
const testApp = new Hono();
testApp.route('/v1/gigs', gigsRouter);

// ---------------------------------------------------------------------------
// Setup / Cleanup
// ---------------------------------------------------------------------------

async function setup() {
  console.log('🔧 Setting up gig test agents...');

  [sellerKeyHash, buyerKeyHash] = await Promise.all([
    bcrypt.hash(SELLER_KEY, 4),
    bcrypt.hash(BUYER_KEY, 4),
  ]);

  await cleanupData();

  await db.insert(agents).values([
    {
      id: SELLER_ID,
      name: 'Gig Seller Agent',
      ownerTwitter: TEST_TWITTERS[0],
      status: 'verified',
      balancePoints: '100',
      apiKeyHash: sellerKeyHash,
    },
    {
      id: BUYER_ID,
      name: 'Gig Buyer Agent',
      ownerTwitter: TEST_TWITTERS[1],
      status: 'verified',
      balancePoints: '1000',  // enough for multiple order placements
      apiKeyHash: buyerKeyHash,
    },
  ]);

  console.log('  ✅ Test agents created (seller, buyer with 1000 points)');
}

async function cleanupData() {
  // Delete in FK dependency order (transactions → order_messages → gig_orders → gigs → agents)
  const agentSetSubquery = sql`
    SELECT id FROM agents
    WHERE id IN (${SELLER_ID}, ${BUYER_ID})
       OR owner_twitter IN (${TEST_TWITTERS[0]}, ${TEST_TWITTERS[1]})
  `;

  // 1. Transactions involving our agents
  await db.execute(sql`
    DELETE FROM transactions
    WHERE from_agent_id IN (${agentSetSubquery})
       OR to_agent_id   IN (${agentSetSubquery})
  `);

  // 2. Order messages on gigs owned by our agents
  await db.execute(sql`
    DELETE FROM order_messages
    WHERE gig_id IN (
      SELECT id FROM gigs WHERE creator_agent_id IN (${agentSetSubquery})
    )
       OR sender_agent_id    IN (${agentSetSubquery})
       OR recipient_agent_id IN (${agentSetSubquery})
  `);

  // 3. Gig orders linked to our agents (as buyer or seller)
  await db.execute(sql`
    DELETE FROM gig_orders
    WHERE buyer_agent_id  IN (${agentSetSubquery})
       OR seller_agent_id IN (${agentSetSubquery})
  `);

  // 4. Gigs created by our agents
  await db.execute(sql`
    DELETE FROM gigs WHERE creator_agent_id IN (${agentSetSubquery})
  `);

  // 5. Agents themselves
  await db.execute(sql`
    DELETE FROM agents
    WHERE id IN (${SELLER_ID}, ${BUYER_ID})
       OR owner_twitter IN (${TEST_TWITTERS[0]}, ${TEST_TWITTERS[1]})
  `);
}

async function cleanup() {
  console.log('🧹 Cleaning up gig test data...');
  await cleanupData();
  console.log('  ✅ Cleanup complete');
}

// ---------------------------------------------------------------------------
// Helper: make a JSON request
// ---------------------------------------------------------------------------
function req(
  method: string,
  path: string,
  opts: { auth?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.auth) headers['Authorization'] = `Bearer ${opts.auth}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

// ---------------------------------------------------------------------------
// Test 1: Create gig → 201, all fields saved
// ---------------------------------------------------------------------------
async function testCreateGig(): Promise<string> {
  console.log('\n📝 Test 1: POST /v1/gigs → 201 (create gig with all fields)');

  const resp = await testApp.fetch(req('POST', '/v1/gigs', {
    auth: SELLER_KEY,
    body: {
      title: 'Write a compelling blog post',
      description: 'I will write a 1000-word SEO-optimised blog post on any topic you choose.',
      category: 'content',
      price_points: 100,
      delivery_days: 3,
    },
  }));

  if (resp.status !== 201) {
    const body = await resp.text();
    throw new Error(`Expected 201, got ${resp.status}: ${body}`);
  }

  const gig = await resp.json() as Record<string, unknown>;

  if (!gig.id)                                        throw new Error('Missing gig id');
  if (gig.creator_agent_id !== SELLER_ID)             throw new Error(`Wrong creator: ${gig.creator_agent_id}`);
  if (gig.title !== 'Write a compelling blog post')   throw new Error(`Wrong title: ${gig.title}`);
  if (typeof gig.description !== 'string')            throw new Error('Missing description');
  if (gig.category !== 'content')                     throw new Error(`Wrong category: ${gig.category}`);
  if (gig.price_points !== 100)                       throw new Error(`Wrong price_points: ${gig.price_points}`);
  if (gig.delivery_days !== 3)                        throw new Error(`Wrong delivery_days: ${gig.delivery_days}`);
  if (gig.status !== 'open')                          throw new Error(`Wrong status: ${gig.status}`);

  // Verify DB row
  const [row] = await db.select().from(gigs).where(eq(gigs.id, gig.id as string)).limit(1);
  if (!row)                                           throw new Error('Gig not found in DB');
  if (row.creatorAgentId !== SELLER_ID)               throw new Error('DB: wrong creator');
  if (parseFloat(row.pricePoints ?? '0') !== 100)     throw new Error(`DB: wrong price_points: ${row.pricePoints}`);
  if (row.deliveryDays !== 3)                         throw new Error(`DB: wrong delivery_days: ${row.deliveryDays}`);

  console.log(`  → Gig created: ${gig.id}`);
  console.log(`  → title="${gig.title}", category=${gig.category}, price_points=${gig.price_points}, delivery_days=${gig.delivery_days}`);
  console.log('  ✅ All fields saved correctly');

  return gig.id as string;
}

// ---------------------------------------------------------------------------
// Test 2: List gigs → paginated public listing
// ---------------------------------------------------------------------------
async function testListGigs(gigId: string) {
  console.log('\n📋 Test 2: GET /v1/gigs → paginated public listing');

  const resp = await testApp.fetch(req('GET', '/v1/gigs?limit=20&offset=0'));

  if (resp.status !== 200) {
    const body = await resp.text();
    throw new Error(`Expected 200, got ${resp.status}: ${body}`);
  }

  const body = await resp.json() as Record<string, unknown>;

  if (!Array.isArray(body.gigs))       throw new Error('Expected gigs array');
  if (typeof body.limit !== 'number')  throw new Error('Missing limit field');
  if (typeof body.offset !== 'number') throw new Error('Missing offset field');

  const found = (body.gigs as Array<Record<string, unknown>>).find((g) => g.id === gigId);
  if (!found) throw new Error(`Gig ${gigId} not found in listing`);

  console.log(`  → Listed ${(body.gigs as unknown[]).length} gigs (limit=${body.limit}, offset=${body.offset})`);
  console.log(`  → Created gig ${gigId} is present in listing`);
  console.log('  ✅ Paginated public listing works');
}

// ---------------------------------------------------------------------------
// Test 3: Get gig → 200 with full details
// ---------------------------------------------------------------------------
async function testGetGig(gigId: string) {
  console.log('\n🔍 Test 3: GET /v1/gigs/:id → 200 with full details');

  const resp = await testApp.fetch(req('GET', `/v1/gigs/${gigId}`));

  if (resp.status !== 200) {
    const body = await resp.text();
    throw new Error(`Expected 200, got ${resp.status}: ${body}`);
  }

  const gig = await resp.json() as Record<string, unknown>;

  if (gig.id !== gigId)                   throw new Error(`Wrong id: ${gig.id}`);
  if (gig.creator_agent_id !== SELLER_ID) throw new Error('Wrong creator');
  if (typeof gig.title !== 'string')      throw new Error('Missing title');
  if (typeof gig.description !== 'string') throw new Error('Missing description');
  if (typeof gig.category !== 'string')   throw new Error('Missing category');
  if (typeof gig.status !== 'string')     throw new Error('Missing status');

  console.log(`  → Fetched gig: id=${gig.id}, status=${gig.status}`);
  console.log('  ✅ GET /v1/gigs/:id returns full gig details');
}

// ---------------------------------------------------------------------------
// Test 4: Update gig → 200 (owner only)
// ---------------------------------------------------------------------------
async function testUpdateGig(gigId: string) {
  console.log('\n✏️  Test 4: PATCH /v1/gigs/:id → 200 (owner update)');

  const resp = await testApp.fetch(req('PATCH', `/v1/gigs/${gigId}`, {
    auth: SELLER_KEY,
    body: {
      title: 'Write a compelling blog post (UPDATED)',
      price_points: 120,
      delivery_days: 5,
    },
  }));

  if (resp.status !== 200) {
    const body = await resp.text();
    throw new Error(`Expected 200, got ${resp.status}: ${body}`);
  }

  const updated = await resp.json() as Record<string, unknown>;

  if (updated.title !== 'Write a compelling blog post (UPDATED)') {
    throw new Error(`Title not updated: ${updated.title}`);
  }
  if (updated.price_points !== 120)  throw new Error(`price_points not updated: ${updated.price_points}`);
  if (updated.delivery_days !== 5)   throw new Error(`delivery_days not updated: ${updated.delivery_days}`);

  console.log(`  → Updated title: "${updated.title}"`);
  console.log(`  → Updated price_points: ${updated.price_points}, delivery_days: ${updated.delivery_days}`);
  console.log('  ✅ Owner can update gig fields');
}

// ---------------------------------------------------------------------------
// Test 5: Create gig without auth → 401
// ---------------------------------------------------------------------------
async function testCreateGigNoAuth() {
  console.log('\n🚫 Test 5: POST /v1/gigs (no auth) → 401');

  const resp = await testApp.fetch(req('POST', '/v1/gigs', {
    body: { title: 'Unauth gig', description: 'desc', category: 'content', price_points: 50 },
  }));

  if (resp.status !== 401) {
    throw new Error(`Expected 401, got ${resp.status}`);
  }

  const body = await resp.json() as Record<string, unknown>;
  if (!body.error) throw new Error('Missing error field');

  console.log(`  → Got 401: ${body.error} — ${body.message}`);
  console.log('  ✅ Creating a gig without auth returns 401');
}

// ---------------------------------------------------------------------------
// Test 6: Non-owner tries to update gig → 403
// ---------------------------------------------------------------------------
async function testUpdateGigNonOwner(gigId: string) {
  console.log('\n🔒 Test 6: PATCH /v1/gigs/:id (non-owner) → 403');

  const resp = await testApp.fetch(req('PATCH', `/v1/gigs/${gigId}`, {
    auth: BUYER_KEY,
    body: { title: 'Hacked title' },
  }));

  if (resp.status !== 403) {
    throw new Error(`Expected 403, got ${resp.status}`);
  }

  const body = await resp.json() as Record<string, unknown>;
  console.log(`  → Got 403: ${body.message}`);
  console.log('  ✅ Non-owner cannot update gig');
}

// ---------------------------------------------------------------------------
// Test 7: Non-owner tries to delete gig → 403
// ---------------------------------------------------------------------------
async function testDeleteGigNonOwner(gigId: string) {
  console.log('\n🔒 Test 7: DELETE /v1/gigs/:id (non-owner) → 403');

  const resp = await testApp.fetch(req('DELETE', `/v1/gigs/${gigId}`, {
    auth: BUYER_KEY,
  }));

  if (resp.status !== 403) {
    throw new Error(`Expected 403, got ${resp.status}`);
  }

  const body = await resp.json() as Record<string, unknown>;
  console.log(`  → Got 403: ${body.message}`);
  console.log('  ✅ Non-owner cannot delete gig');
}

// ---------------------------------------------------------------------------
// Test 8: Owner deletes gig → 200
// ---------------------------------------------------------------------------
async function testDeleteGig(gigId: string) {
  console.log('\n🗑️  Test 8: DELETE /v1/gigs/:id (owner) → 200');

  const resp = await testApp.fetch(req('DELETE', `/v1/gigs/${gigId}`, {
    auth: SELLER_KEY,
  }));

  if (resp.status !== 200) {
    const body = await resp.text();
    throw new Error(`Expected 200, got ${resp.status}: ${body}`);
  }

  const body = await resp.json() as Record<string, unknown>;
  if (typeof body.message !== 'string') throw new Error('Expected message in response');

  // Verify DB: gig status set to 'canceled'
  const [row] = await db.select().from(gigs).where(eq(gigs.id, gigId)).limit(1);
  if (!row)                      throw new Error('Gig not found in DB after delete');
  if (row.status !== 'canceled') throw new Error(`Expected status=canceled, got ${row.status}`);

  console.log(`  → Got 200: ${body.message}`);
  console.log(`  → DB gig status: ${row.status}`);
  console.log('  ✅ Owner can delete (close) gig; status set to canceled');
}

// ---------------------------------------------------------------------------
// Test 9: Place order → 201, status=pending
// ---------------------------------------------------------------------------
async function testPlaceOrder(gigId: string): Promise<string> {
  console.log('\n🛒 Test 9: POST /v1/gigs/:gigId/orders → 201, status=pending');

  const resp = await testApp.fetch(req('POST', `/v1/gigs/${gigId}/orders`, {
    auth: BUYER_KEY,
    body: { requirements: 'Please focus on AI topics and make it engaging.' },
  }));

  if (resp.status !== 201) {
    const body = await resp.text();
    throw new Error(`Expected 201, got ${resp.status}: ${body}`);
  }

  const order = await resp.json() as Record<string, unknown>;

  if (!order.id)                           throw new Error('Missing order id');
  if (order.gig_id !== gigId)              throw new Error(`Wrong gig_id: ${order.gig_id}`);
  if (order.buyer_agent_id !== BUYER_ID)   throw new Error(`Wrong buyer: ${order.buyer_agent_id}`);
  if (order.seller_agent_id !== SELLER_ID) throw new Error(`Wrong seller: ${order.seller_agent_id}`);
  if (order.status !== 'pending')          throw new Error(`Expected pending, got ${order.status}`);
  if (order.price_points !== 100)          throw new Error(`Wrong price_points: ${order.price_points}`);

  // Verify DB row
  const [row] = await db.select().from(gigOrders).where(eq(gigOrders.id, order.id as string)).limit(1);
  if (!row)                          throw new Error('Order not found in DB');
  if (row.status !== 'pending')      throw new Error(`DB: expected pending, got ${row.status}`);
  if (row.buyerAgentId !== BUYER_ID) throw new Error('DB: wrong buyer');

  console.log(`  → Order created: ${order.id}`);
  console.log(`  → status=${order.status}, price_points=${order.price_points}`);
  console.log('  ✅ Order placed successfully with status=pending');

  return order.id as string;
}

// ---------------------------------------------------------------------------
// Test 10: Delivery timeline — verify delivery_days deadline accessible
// ---------------------------------------------------------------------------
async function testDeliveryTimeline(gigId: string, orderId: string) {
  console.log('\n📅 Test 10: Delivery timeline — verify delivery_days deadline at order creation');

  // Fetch the gig to get delivery_days
  const gigResp = await testApp.fetch(req('GET', `/v1/gigs/${gigId}`));
  if (gigResp.status !== 200) throw new Error(`Failed to fetch gig: ${gigResp.status}`);
  const gig = await gigResp.json() as Record<string, unknown>;

  if (gig.delivery_days !== 5) {
    throw new Error(`Expected delivery_days=5 on gig, got ${gig.delivery_days}`);
  }

  // Verify the order has created_at timestamp
  const [order] = await db.select().from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  if (!order)             throw new Error('Order not found in DB');
  if (!order.createdAt)  throw new Error('Order missing created_at');

  // Compute implied deadline: created_at + delivery_days
  const deadlineMs = order.createdAt.getTime() + (gig.delivery_days as number) * 24 * 60 * 60 * 1000;
  const deadline = new Date(deadlineMs);

  // Verify deadline is reasonable (between now and +delivery_days+1 days from order creation)
  const now = Date.now();
  if (deadlineMs < now) {
    throw new Error('Delivery deadline is in the past — unexpected for a just-created order');
  }
  const maxExpectedMs = order.createdAt.getTime() + ((gig.delivery_days as number) + 1) * 24 * 60 * 60 * 1000;
  if (deadlineMs > maxExpectedMs) {
    throw new Error(`Deadline too far in the future: ${deadline.toISOString()}`);
  }

  console.log(`  → Gig delivery_days: ${gig.delivery_days}`);
  console.log(`  → Order created_at: ${order.createdAt.toISOString()}`);
  console.log(`  → Computed delivery deadline: ${deadline.toISOString()}`);
  console.log('  ✅ Delivery deadline can be computed from gig.delivery_days + order.created_at');
}

// ---------------------------------------------------------------------------
// Test 11: Cancel pending order (buyer) → 200, refund issued
// ---------------------------------------------------------------------------
async function testCancelPendingOrder(orderId: string) {
  console.log('\n❌ Test 11: Cancel pending order (buyer) → 200, refund issued');

  // Check buyer balance before cancel
  const [buyerBefore] = await db
    .select({ balance: agents.balancePoints })
    .from(agents)
    .where(eq(agents.id, BUYER_ID))
    .limit(1);
  const balanceBefore = parseFloat(buyerBefore?.balance ?? '0');

  const resp = await testApp.fetch(req('POST', `/v1/gigs/orders/${orderId}/cancel`, {
    auth: BUYER_KEY,
  }));

  if (resp.status !== 200) {
    const body = await resp.text();
    throw new Error(`Expected 200, got ${resp.status}: ${body}`);
  }

  const body = await resp.json() as Record<string, unknown>;
  if (body.status !== 'cancelled') throw new Error(`Expected cancelled, got ${body.status}`);

  // Verify refund: buyer balance should be restored
  const [buyerAfter] = await db
    .select({ balance: agents.balancePoints })
    .from(agents)
    .where(eq(agents.id, BUYER_ID))
    .limit(1);
  const balanceAfter = parseFloat(buyerAfter?.balance ?? '0');

  if (balanceAfter <= balanceBefore) {
    throw new Error(`Expected balance to increase after refund. Before: ${balanceBefore}, after: ${balanceAfter}`);
  }

  console.log(`  → Order ${orderId}: status=${body.status}`);
  console.log(`  → Buyer balance restored: ${balanceBefore} → ${balanceAfter} (+${balanceAfter - balanceBefore})`);
  console.log('  ✅ Buyer can cancel pending order; refund issued');
}

// ---------------------------------------------------------------------------
// Test 12: Seller accepts order → status=accepted
// ---------------------------------------------------------------------------
async function testAcceptOrder(orderId: string) {
  console.log('\n✔️  Test 12: POST /v1/gigs/orders/:orderId/accept (seller) → status=accepted');

  const resp = await testApp.fetch(req('POST', `/v1/gigs/orders/${orderId}/accept`, {
    auth: SELLER_KEY,
  }));

  if (resp.status !== 200) {
    const body = await resp.text();
    throw new Error(`Expected 200, got ${resp.status}: ${body}`);
  }

  const order = await resp.json() as Record<string, unknown>;
  if (order.status !== 'accepted') throw new Error(`Expected accepted, got ${order.status}`);
  if (!order.accepted_at)          throw new Error('Missing accepted_at timestamp');

  // Verify DB
  const [row] = await db.select().from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  if (row?.status !== 'accepted') throw new Error(`DB: expected accepted, got ${row?.status}`);
  if (!row?.acceptedAt)           throw new Error('DB: missing acceptedAt');

  console.log(`  → Order ${orderId}: status=${order.status}, accepted_at=${order.accepted_at}`);
  console.log('  ✅ Seller accepted order; status=accepted, acceptedAt set');
}

// ---------------------------------------------------------------------------
// Test 13: Buyer tries to cancel accepted order → 409
// ---------------------------------------------------------------------------
async function testCancelAfterAccepted(orderId: string) {
  console.log('\n⛔ Test 13: Cancel after accepted (buyer) → 409');

  const resp = await testApp.fetch(req('POST', `/v1/gigs/orders/${orderId}/cancel`, {
    auth: BUYER_KEY,
  }));

  if (resp.status !== 409) {
    const body = await resp.text();
    throw new Error(`Expected 409, got ${resp.status}: ${body}`);
  }

  const body = await resp.json() as Record<string, unknown>;
  console.log(`  → Got 409: ${body.message}`);
  console.log('  ✅ Buyers cannot cancel orders after they have been accepted');
}

// ---------------------------------------------------------------------------
// Test 14: Seller delivers work → status=delivered
// ---------------------------------------------------------------------------
async function testDeliverOrder(orderId: string) {
  console.log('\n📦 Test 14: POST /v1/gigs/orders/:orderId/deliver (seller) → status=delivered');

  const resp = await testApp.fetch(req('POST', `/v1/gigs/orders/${orderId}/deliver`, {
    auth: SELLER_KEY,
    body: {
      delivery_url: 'https://docs.example.com/blog-post-draft.pdf',
      delivery_notes: 'Draft is ready for review. Total 1050 words covering AI in 2025.',
    },
  }));

  if (resp.status !== 200) {
    const body = await resp.text();
    throw new Error(`Expected 200, got ${resp.status}: ${body}`);
  }

  const order = await resp.json() as Record<string, unknown>;
  if (order.status !== 'delivered')                            throw new Error(`Expected delivered, got ${order.status}`);
  if (order.delivery_url !== 'https://docs.example.com/blog-post-draft.pdf') {
    throw new Error(`Wrong delivery_url: ${order.delivery_url}`);
  }
  if (!order.delivered_at) throw new Error('Missing delivered_at timestamp');

  // Verify DB
  const [row] = await db.select().from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  if (row?.status !== 'delivered') throw new Error(`DB: expected delivered, got ${row?.status}`);
  if (!row?.deliveredAt)           throw new Error('DB: missing deliveredAt');

  console.log(`  → Order ${orderId}: status=${order.status}`);
  console.log(`  → delivery_url: ${order.delivery_url}`);
  console.log(`  → delivered_at: ${order.delivered_at}`);
  console.log('  ✅ Seller submitted delivery; status=delivered');
}

// ---------------------------------------------------------------------------
// Test 15: Buyer requests revision → status=revision_requested
// ---------------------------------------------------------------------------
async function testRequestRevision(orderId: string) {
  console.log('\n🔄 Test 15: POST /v1/gigs/orders/:orderId/request-revision → status=revision_requested');

  const resp = await testApp.fetch(req('POST', `/v1/gigs/orders/${orderId}/request-revision`, {
    auth: BUYER_KEY,
    body: { feedback: 'Please add more statistics and real-world examples to support the arguments.' },
  }));

  if (resp.status !== 200) {
    const body = await resp.text();
    throw new Error(`Expected 200, got ${resp.status}: ${body}`);
  }

  const order = await resp.json() as Record<string, unknown>;
  if (order.status !== 'revision_requested') throw new Error(`Expected revision_requested, got ${order.status}`);
  if (order.revision_count !== 1)            throw new Error(`Expected revision_count=1, got ${order.revision_count}`);

  // Verify DB
  const [row] = await db.select().from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  if (row?.status !== 'revision_requested')   throw new Error(`DB: expected revision_requested, got ${row?.status}`);
  if (parseInt(row?.revisionCount ?? '0', 10) !== 1) {
    throw new Error(`DB: expected revisionCount=1, got ${row?.revisionCount}`);
  }
  if (!row?.buyerFeedback) throw new Error('DB: missing buyerFeedback');

  console.log(`  → Order ${orderId}: status=${order.status}, revision_count=${order.revision_count}`);
  console.log(`  → Feedback stored in DB: "${row.buyerFeedback?.slice(0, 60)}..."`);
  console.log('  ✅ Buyer requested revision; status=revision_requested');
}

// ---------------------------------------------------------------------------
// Test 16: Seller re-delivers (revision_requested → delivered)
// ---------------------------------------------------------------------------
async function testReDeliver(orderId: string) {
  console.log('\n📦 Test 16: Re-deliver after revision request (seller) → status=delivered');

  const resp = await testApp.fetch(req('POST', `/v1/gigs/orders/${orderId}/deliver`, {
    auth: SELLER_KEY,
    body: {
      delivery_content: 'Revised blog post with additional statistics and 3 real-world case studies added.',
      delivery_notes: 'Addressed all feedback. Word count now 1200.',
    },
  }));

  if (resp.status !== 200) {
    const body = await resp.text();
    throw new Error(`Expected 200, got ${resp.status}: ${body}`);
  }

  const order = await resp.json() as Record<string, unknown>;
  if (order.status !== 'delivered') throw new Error(`Expected delivered, got ${order.status}`);

  console.log(`  → Order ${orderId}: status=${order.status} (re-delivered after revision)`);
  console.log('  ✅ Seller can re-deliver after revision request');
}

// ---------------------------------------------------------------------------
// Test 17: Buyer accepts delivery → status=completed, payment released
// ---------------------------------------------------------------------------
async function testCompleteOrder(orderId: string) {
  console.log('\n🎉 Test 17: POST /v1/gigs/orders/:orderId/complete (buyer) → status=completed');

  // Record seller balance before completion
  const [sellerBefore] = await db
    .select({ balance: agents.balancePoints })
    .from(agents)
    .where(eq(agents.id, SELLER_ID))
    .limit(1);
  const sellerBalanceBefore = parseFloat(sellerBefore?.balance ?? '0');

  const resp = await testApp.fetch(req('POST', `/v1/gigs/orders/${orderId}/complete`, {
    auth: BUYER_KEY,
  }));

  if (resp.status !== 200) {
    const body = await resp.text();
    throw new Error(`Expected 200, got ${resp.status}: ${body}`);
  }

  const order = await resp.json() as Record<string, unknown>;
  if (order.status !== 'completed') throw new Error(`Expected completed, got ${order.status}`);
  if (!order.completed_at)          throw new Error('Missing completed_at timestamp');

  // Verify DB
  const [row] = await db.select().from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  if (row?.status !== 'completed') throw new Error(`DB: expected completed, got ${row?.status}`);
  if (!row?.completedAt)           throw new Error('DB: missing completedAt');

  // Verify seller received payment (95% of 100 = 95 points)
  const [sellerAfter] = await db
    .select({ balance: agents.balancePoints })
    .from(agents)
    .where(eq(agents.id, SELLER_ID))
    .limit(1);
  const sellerBalanceAfter = parseFloat(sellerAfter?.balance ?? '0');
  const netExpected = 95; // 100 points × (1 - 0.05)

  if (sellerBalanceAfter - sellerBalanceBefore < netExpected - 0.01) {
    throw new Error(
      `Seller balance not increased by expected amount. Before: ${sellerBalanceBefore}, after: ${sellerBalanceAfter}, expected +${netExpected}`,
    );
  }

  console.log(`  → Order ${orderId}: status=${order.status}`);
  console.log(`  → completed_at: ${order.completed_at}`);
  console.log(`  → Seller balance: ${sellerBalanceBefore} → ${sellerBalanceAfter} (+${(sellerBalanceAfter - sellerBalanceBefore).toFixed(2)} points)`);
  console.log('  ✅ Buyer accepted delivery; status=completed, payment released to seller');
}

// ---------------------------------------------------------------------------
// Test 18: State machine — invalid transitions rejected
// ---------------------------------------------------------------------------
async function testInvalidTransitions(completedOrderId: string, gigId: string) {
  console.log('\n⚙️  Test 18: State machine — invalid transitions rejected (409)');

  // 18a: Try to accept an already completed order (completed → accepted is invalid)
  const acceptResp = await testApp.fetch(req('POST', `/v1/gigs/orders/${completedOrderId}/accept`, {
    auth: SELLER_KEY,
  }));
  if (acceptResp.status !== 409) {
    throw new Error(`Expected 409 for accept on completed order, got ${acceptResp.status}`);
  }
  const acceptBody = await acceptResp.json() as Record<string, unknown>;
  console.log(`  → accept completed order → 409: "${acceptBody.message}"`);

  // 18b: Try to deliver a completed order (completed → delivered is invalid)
  const deliverResp = await testApp.fetch(req('POST', `/v1/gigs/orders/${completedOrderId}/deliver`, {
    auth: SELLER_KEY,
    body: { delivery_url: 'https://example.com/bogus' },
  }));
  if (deliverResp.status !== 409) {
    throw new Error(`Expected 409 for deliver on completed order, got ${deliverResp.status}`);
  }
  const deliverBody = await deliverResp.json() as Record<string, unknown>;
  console.log(`  → deliver completed order → 409: "${deliverBody.message}"`);

  // 18c: Try to complete a completed order (completed → completed is invalid)
  const completeResp = await testApp.fetch(req('POST', `/v1/gigs/orders/${completedOrderId}/complete`, {
    auth: BUYER_KEY,
  }));
  if (completeResp.status !== 409) {
    throw new Error(`Expected 409 for complete on completed order, got ${completeResp.status}`);
  }
  const completeBody = await completeResp.json() as Record<string, unknown>;
  console.log(`  → complete completed order → 409: "${completeBody.message}"`);

  // 18d: Place a new order, then try to deliver it directly (pending → delivered is invalid)
  const orderResp = await testApp.fetch(req('POST', `/v1/gigs/${gigId}/orders`, {
    auth: BUYER_KEY,
    body: {},
  }));
  if (orderResp.status !== 201) {
    throw new Error(`Failed to place order for state machine test: ${orderResp.status}`);
  }
  const newOrder = await orderResp.json() as Record<string, unknown>;
  const newOrderId = newOrder.id as string;

  const deliverPendingResp = await testApp.fetch(req('POST', `/v1/gigs/orders/${newOrderId}/deliver`, {
    auth: SELLER_KEY,
    body: { delivery_url: 'https://example.com/early' },
  }));
  if (deliverPendingResp.status !== 409) {
    throw new Error(`Expected 409 for deliver on pending order, got ${deliverPendingResp.status}`);
  }
  const deliverPendingBody = await deliverPendingResp.json() as Record<string, unknown>;
  console.log(`  → deliver pending order (skipping accept) → 409: "${deliverPendingBody.message}"`);

  // 18e: Try to request revision on a pending order (pending → revision_requested is invalid)
  const revisionPendingResp = await testApp.fetch(req('POST', `/v1/gigs/orders/${newOrderId}/request-revision`, {
    auth: BUYER_KEY,
    body: { feedback: 'Too early' },
  }));
  if (revisionPendingResp.status !== 409) {
    throw new Error(`Expected 409 for revision on pending order, got ${revisionPendingResp.status}`);
  }
  console.log('  → request-revision on pending order → 409 ✓');

  // Clean up the extra order (cancel it)
  await testApp.fetch(req('POST', `/v1/gigs/orders/${newOrderId}/cancel`, {
    auth: BUYER_KEY,
  }));

  console.log('  ✅ All invalid state transitions correctly rejected with 409');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('🚀 Gig Marketplace Integration Tests');
  console.log('='.repeat(55));

  await initPool();
  await setup();

  let passCount = 0;
  let failCount = 0;

  const run = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      const result = await fn();
      passCount++;
      return result;
    } catch (err) {
      console.error(`\n  ❌ FAILED: ${name}`);
      console.error(`     ${err instanceof Error ? err.message : String(err)}`);
      failCount++;
      return null;
    }
  };

  // ── A. Gig CRUD Tests ─────────────────────────────────────────────────────
  const gigIdA = await run('Test 1: Create gig', testCreateGig);

  if (gigIdA) {
    await run('Test 2: List gigs', () => testListGigs(gigIdA));
    await run('Test 3: Get gig', () => testGetGig(gigIdA));
    await run('Test 4: Update gig (owner)', () => testUpdateGig(gigIdA));
    await run('Test 5: Create gig — no auth → 401', testCreateGigNoAuth);
    await run('Test 6: Update gig — non-owner → 403', () => testUpdateGigNonOwner(gigIdA));
    await run('Test 7: Delete gig — non-owner → 403', () => testDeleteGigNonOwner(gigIdA));
    await run('Test 8: Delete gig — owner → 200', () => testDeleteGig(gigIdA));
  } else {
    console.log('\n  ⚠️  Skipping CRUD tests 2–8 (gig creation failed)');
    failCount += 7;
  }

  // ── B. Order Lifecycle Tests (fresh gig with delivery_days) ───────────────
  console.log('\n' + '─'.repeat(55));
  console.log('📦 Creating fresh gig for order lifecycle tests...');

  // Create a fresh open gig for order tests
  let lifecycleGigId: string | null = null;
  try {
    const createResp = await testApp.fetch(req('POST', '/v1/gigs', {
      auth: SELLER_KEY,
      body: {
        title: 'Build a landing page',
        description: 'I will build a professional landing page with React.',
        category: 'development',
        price_points: 100,
        delivery_days: 5,
      },
    }));
    if (createResp.status !== 201) throw new Error(`Gig creation failed: ${createResp.status}`);
    const gigData = await createResp.json() as Record<string, unknown>;
    lifecycleGigId = gigData.id as string;
    console.log(`  → Lifecycle gig created: ${lifecycleGigId} (delivery_days=5, price=100pts)`);
    passCount++;
  } catch (err) {
    console.error(`  ❌ Failed to create lifecycle gig: ${err instanceof Error ? err.message : err}`);
    failCount++;
  }

  if (lifecycleGigId) {
    // Test 9: Place order (order1 — will be used for delivery timeline + cancel tests)
    const order1Id = await run('Test 9: Place order → 201, status=pending', () =>
      testPlaceOrder(lifecycleGigId!),
    );

    if (order1Id) {
      await run('Test 10: Delivery timeline', () =>
        testDeliveryTimeline(lifecycleGigId!, order1Id),
      );
      await run('Test 11: Cancel pending order (buyer) → 200', () =>
        testCancelPendingOrder(order1Id),
      );
    } else {
      failCount += 2;
    }

    // Place order2 for the full lifecycle (accept → deliver → revision → re-deliver → complete)
    console.log('\n  📋 Placing order2 for full order lifecycle...');
    let order2Id: string | null = null;
    try {
      const order2Resp = await testApp.fetch(req('POST', `/v1/gigs/${lifecycleGigId}/orders`, {
        auth: BUYER_KEY,
        body: { requirements: 'Mobile-first design, React 18, TypeScript.' },
      }));
      if (order2Resp.status !== 201) throw new Error(`Order2 creation failed: ${order2Resp.status}: ${await order2Resp.text()}`);
      const order2Data = await order2Resp.json() as Record<string, unknown>;
      order2Id = order2Data.id as string;
      console.log(`  → Order2 created: ${order2Id} (status=${order2Data.status})`);
      passCount++;
    } catch (err) {
      console.error(`  ❌ Failed to create order2: ${err instanceof Error ? err.message : err}`);
      failCount++;
    }

    if (order2Id) {
      await run('Test 12: Accept order (seller) → status=accepted', () =>
        testAcceptOrder(order2Id!),
      );
      await run('Test 13: Cancel after accepted (buyer) → 409', () =>
        testCancelAfterAccepted(order2Id!),
      );
      await run('Test 14: Deliver order (seller) → status=delivered', () =>
        testDeliverOrder(order2Id!),
      );
      await run('Test 15: Request revision (buyer) → status=revision_requested', () =>
        testRequestRevision(order2Id!),
      );
      await run('Test 16: Re-deliver (seller) → status=delivered', () =>
        testReDeliver(order2Id!),
      );
      await run('Test 17: Complete order (buyer) → status=completed', () =>
        testCompleteOrder(order2Id!),
      );
      await run('Test 18: State machine — invalid transitions → 409', () =>
        testInvalidTransitions(order2Id!, lifecycleGigId!),
      );
    } else {
      console.log('\n  ⚠️  Skipping order lifecycle tests 12–18 (order2 creation failed)');
      failCount += 7;
    }
  } else {
    console.log('\n  ⚠️  Skipping all order lifecycle tests (lifecycle gig creation failed)');
    failCount += 10;
  }

  await cleanup();

  console.log('\n' + '='.repeat(55));
  console.log(`Results: ${passCount} passed, ${failCount} failed`);

  if (failCount > 0) {
    console.log('\n⚠️  Some tests failed. Review output above.');
    process.exit(1);
  } else {
    console.log('🎉 All gig integration tests passed!');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
