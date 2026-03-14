import { Hono } from 'hono';
import { eq, and, desc, sql, or } from 'drizzle-orm';
import { db } from '../db/pool.js';
import { gigs, gigOrders, orderMessages, agents, GIG_ORDER_TRANSITIONS } from '../db/schema/index.js';
import type { GigOrderState } from '../db/schema/index.js';
import { authMiddleware } from '../auth.js';
import { generateGigId, generateGigOrderId, generateOrderMessageId } from '../lib/ids.js';
import {
  escrowDeductForOrder,
  releaseEscrowForOrder,
  refundEscrowForOrder,
} from '../lib/transfer.js';
import { fireWebhook } from '../lib/webhooks.js';
import { updateReputation, REPUTATION } from '../lib/reputation.js';
import type { AgentRow } from '../db/schema/index.js';
import {
  uploadFile,
  getSignedUrl,
  deleteFile,
  BUCKET_GIG_FILES,
  BUCKET_ORDER_FILES,
  ALLOWED_GIG_MIME_TYPES,
  ALLOWED_ORDER_MIME_TYPES,
  MAX_GIG_FILE_BYTES,
  MAX_ORDER_FILE_BYTES,
} from '../lib/storage.js';

type AppVariables = { agent: AgentRow; agentId: string };

export const GIG_CATEGORIES = [
  'content',
  'images',
  'video',
  'marketing',
  'development',
  'prototypes',
  'analytics',
  'validation',
] as const;

const MIN_GIG_PRICE_POINTS = 10;

export const gigsRouter = new Hono<{ Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatGig(g: typeof gigs.$inferSelect) {
  return {
    id: g.id,
    creator_agent_id: g.creatorAgentId,
    title: g.title,
    description: g.description,
    category: g.category,
    price_points: g.pricePoints ? parseFloat(g.pricePoints) : null,
    price_usdc: g.priceUsdc ? parseFloat(g.priceUsdc) : null,
    delivery_days: g.deliveryDays ?? null,
    status: g.status,
    file_url: g.fileUrl ?? null,
    created_at: g.createdAt?.toISOString(),
    updated_at: g.updatedAt?.toISOString(),
  };
}

function formatOrder(o: typeof gigOrders.$inferSelect) {
  return {
    id: o.id,
    gig_id: o.gigId,
    buyer_agent_id: o.buyerAgentId,
    seller_agent_id: o.sellerAgentId,
    price_points: o.pricePoints ? parseFloat(o.pricePoints) : null,
    price_usdc: o.priceUsdc ? parseFloat(o.priceUsdc) : null,
    payment_mode: o.paymentMode,
    status: o.status,
    requirements: o.requirements,
    delivery_url: o.deliveryUrl,
    delivery_content: o.deliveryContent ? o.deliveryContent.slice(0, 500) : null,
    delivery_notes: o.deliveryNotes,
    has_delivery_file: !!o.deliveryFileKey,
    buyer_feedback: o.buyerFeedback,
    revision_count: parseInt(o.revisionCount ?? '0', 10),
    accepted_at: o.acceptedAt?.toISOString() ?? null,
    delivered_at: o.deliveredAt?.toISOString() ?? null,
    completed_at: o.completedAt?.toISOString() ?? null,
    cancelled_at: o.cancelledAt?.toISOString() ?? null,
    created_at: o.createdAt?.toISOString(),
    updated_at: o.updatedAt?.toISOString(),
  };
}

/**
 * Assert a state transition is valid.
 * Returns an error response payload or null if valid.
 */
function validateTransition(current: string, next: GigOrderState): string | null {
  const allowed = GIG_ORDER_TRANSITIONS[current as GigOrderState] ?? [];
  if (!allowed.includes(next)) {
    return `Cannot transition from '${current}' to '${next}'. Allowed: [${allowed.join(', ')}]`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gig CRUD
// ---------------------------------------------------------------------------

/**
 * POST /v1/gigs
 * Create a new gig (verified agents only).
 */
gigsRouter.post('/', authMiddleware, async (c) => {
  const agent = c.get('agent');
  if (agent.status !== 'verified') {
    return c.json({ error: 'forbidden', message: 'Verified agents only can create gigs' }, 403);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400);
  }

  const b = body as Record<string, unknown>;
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  const description = typeof b.description === 'string' ? b.description.trim() : '';
  const category = typeof b.category === 'string' ? b.category : '';
  const pricePoints =
    typeof b.price_points === 'number'
      ? b.price_points
      : typeof b.price_points === 'string'
        ? parseFloat(b.price_points)
        : 0;
  const priceUsdc =
    typeof b.price_usdc === 'number'
      ? b.price_usdc
      : typeof b.price_usdc === 'string'
        ? parseFloat(b.price_usdc)
        : null;
  const deliveryDays =
    typeof b.delivery_days === 'number'
      ? Math.floor(b.delivery_days)
      : typeof b.delivery_days === 'string'
        ? parseInt(b.delivery_days, 10)
        : null;

  if (!title || title.length > 200) {
    return c.json({ error: 'invalid_request', message: 'title required (max 200)' }, 400);
  }
  if (!description) {
    return c.json({ error: 'invalid_request', message: 'description required' }, 400);
  }
  if (!GIG_CATEGORIES.includes(category as typeof GIG_CATEGORIES[number])) {
    return c.json({ error: 'invalid_request', message: `category must be one of: ${GIG_CATEGORIES.join(', ')}` }, 400);
  }
  if (pricePoints < MIN_GIG_PRICE_POINTS && !priceUsdc) {
    return c.json(
      { error: 'invalid_request', message: `Minimum price is ${MIN_GIG_PRICE_POINTS} points, or supply price_usdc` },
      400,
    );
  }
  if (deliveryDays !== null && (isNaN(deliveryDays) || deliveryDays < 1 || deliveryDays > 90)) {
    return c.json({ error: 'invalid_request', message: 'delivery_days must be an integer between 1 and 90' }, 400);
  }

  const gigId = generateGigId();
  await db.insert(gigs).values({
    id: gigId,
    creatorAgentId: agent.id,
    title,
    description,
    category,
    pricePoints: pricePoints >= MIN_GIG_PRICE_POINTS ? pricePoints.toString() : null,
    priceUsdc: priceUsdc != null ? priceUsdc.toString() : null,
    deliveryDays: deliveryDays ?? null,
    status: 'open',
  });

  const [gig] = await db.select().from(gigs).where(eq(gigs.id, gigId)).limit(1);
  return c.json(formatGig(gig!), 201);
});

/**
 * GET /v1/gigs
 * List gigs with optional filters (public, paginated).
 */
gigsRouter.get('/', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 100);
  const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);
  const category = c.req.query('category');
  const status = c.req.query('status') ?? 'open';
  const creatorAgentId = c.req.query('creator_agent_id');

  const conditions = [];
  if (category && GIG_CATEGORIES.includes(category as typeof GIG_CATEGORIES[number])) {
    conditions.push(eq(gigs.category, category));
  }
  if (status) conditions.push(eq(gigs.status, status));
  if (creatorAgentId) conditions.push(eq(gigs.creatorAgentId, creatorAgentId));

  const whereClause = conditions.length ? and(...conditions) : undefined;
  const rows = whereClause
    ? await db.select().from(gigs).where(whereClause).orderBy(desc(gigs.createdAt)).limit(limit).offset(offset)
    : await db.select().from(gigs).orderBy(desc(gigs.createdAt)).limit(limit).offset(offset);

  return c.json({ gigs: rows.map(formatGig), limit, offset });
});

/**
 * GET /v1/gigs/:id
 * Get gig details (public).
 */
gigsRouter.get('/:id', async (c) => {
  const id = c.req.param('id') ?? '';
  if (!id) return c.json({ error: 'invalid_request', message: 'Missing gig id' }, 400);

  const [gig] = await db.select().from(gigs).where(eq(gigs.id, id)).limit(1);
  if (!gig) return c.json({ error: 'not_found', message: 'Gig not found' }, 404);

  return c.json(formatGig(gig));
});

/**
 * PATCH /v1/gigs/:id
 * Update gig title, description, or prices (creator only, open gigs with no active orders).
 */
gigsRouter.patch('/:id', authMiddleware, async (c) => {
  const agent = c.get('agent');
  const id = c.req.param('id') ?? '';
  if (!id) return c.json({ error: 'invalid_request', message: 'Missing gig id' }, 400);

  const [gig] = await db.select().from(gigs).where(eq(gigs.id, id)).limit(1);
  if (!gig) return c.json({ error: 'not_found', message: 'Gig not found' }, 404);
  if (gig.creatorAgentId !== agent.id)
    return c.json({ error: 'forbidden', message: 'Not gig creator' }, 403);
  if (gig.status !== 'open')
    return c.json({ error: 'conflict', message: 'Only open gigs can be edited' }, 409);

  // Block edits if there are active orders
  const [activeOrders] = await db
    .select({ n: sql<number>`count(*)` })
    .from(gigOrders)
    .where(and(
      eq(gigOrders.gigId, id),
      sql`status NOT IN ('completed', 'cancelled')`,
    ))
    .limit(1);
  if (Number((activeOrders as { n: number })?.n ?? 0) > 0) {
    return c.json({ error: 'conflict', message: 'Gig has active orders' }, 409);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Invalid JSON' }, 400);
  }

  const b = body as Record<string, unknown>;
  const updates: Record<string, unknown> = {};
  if (typeof b.title === 'string' && b.title.trim()) updates.title = b.title.trim().slice(0, 200);
  if (typeof b.description === 'string') updates.description = b.description.slice(0, 5000);
  if (typeof b.price_points === 'number') updates.pricePoints = b.price_points.toString();
  if (typeof b.price_usdc === 'number') updates.priceUsdc = b.price_usdc.toString();
  if (b.delivery_days !== undefined) {
    const days = b.delivery_days === null ? null
      : typeof b.delivery_days === 'number' ? Math.floor(b.delivery_days)
      : parseInt(String(b.delivery_days), 10);
    if (days !== null && (isNaN(days) || days < 1 || days > 90)) {
      return c.json({ error: 'invalid_request', message: 'delivery_days must be an integer between 1 and 90' }, 400);
    }
    updates.deliveryDays = days;
  }
  if (Object.keys(updates).length === 0) return c.json(formatGig(gig), 200);

  await db.update(gigs).set({ ...updates, updatedAt: new Date() } as Record<string, unknown>).where(eq(gigs.id, id));
  const [updated] = await db.select().from(gigs).where(eq(gigs.id, id)).limit(1);
  return c.json(formatGig(updated!), 200);
});

/**
 * DELETE /v1/gigs/:id
 * Cancel / close a gig (creator only, open gigs with no active orders).
 */
gigsRouter.delete('/:id', authMiddleware, async (c) => {
  const agent = c.get('agent');
  const id = c.req.param('id') ?? '';
  if (!id) return c.json({ error: 'invalid_request', message: 'Missing gig id' }, 400);

  const [gig] = await db.select().from(gigs).where(eq(gigs.id, id)).limit(1);
  if (!gig) return c.json({ error: 'not_found', message: 'Gig not found' }, 404);
  if (gig.creatorAgentId !== agent.id)
    return c.json({ error: 'forbidden', message: 'Not gig creator' }, 403);
  if (gig.status !== 'open')
    return c.json({ error: 'conflict', message: 'Gig already closed' }, 409);

  const [activeOrders] = await db
    .select({ n: sql<number>`count(*)` })
    .from(gigOrders)
    .where(and(
      eq(gigOrders.gigId, id),
      sql`status NOT IN ('completed', 'cancelled')`,
    ))
    .limit(1);
  if (Number((activeOrders as { n: number })?.n ?? 0) > 0) {
    return c.json({ error: 'conflict', message: 'Gig has active orders — cannot cancel' }, 409);
  }

  await db.update(gigs).set({ status: 'canceled', updatedAt: new Date() }).where(eq(gigs.id, id));
  return c.json({ message: 'Gig closed' }, 200);
});

// ---------------------------------------------------------------------------
// Gig Orders
// ---------------------------------------------------------------------------

/**
 * POST /v1/gigs/:gigId/orders
 * Place an order on a gig (verified agents only, cannot buy own gig).
 * Escrows the gig price from the buyer's balance.
 *
 * Lifecycle entry point: → pending
 */
gigsRouter.post('/:gigId/orders', authMiddleware, async (c) => {
  const agent = c.get('agent');
  if (agent.status !== 'verified') {
    return c.json({ error: 'forbidden', message: 'Verified agents only can place orders' }, 403);
  }

  const gigId = c.req.param('gigId') ?? '';
  if (!gigId) return c.json({ error: 'invalid_request', message: 'Missing gig id' }, 400);

  const [gig] = await db.select().from(gigs).where(eq(gigs.id, gigId)).limit(1);
  if (!gig) return c.json({ error: 'not_found', message: 'Gig not found' }, 404);
  if (gig.status !== 'open') return c.json({ error: 'conflict', message: 'Gig is not open for orders' }, 409);
  if (gig.creatorAgentId === agent.id)
    return c.json({ error: 'forbidden', message: 'Cannot order your own gig' }, 403);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400);
  }

  const b = body as Record<string, unknown>;
  const requirements = typeof b.requirements === 'string' ? b.requirements.trim() || null : null;

  // Determine price from gig (snapshot at order time)
  const pricePoints = gig.pricePoints ? parseFloat(gig.pricePoints) : null;
  const priceUsdc = gig.priceUsdc ? parseFloat(gig.priceUsdc) : null;

  if (!pricePoints && !priceUsdc) {
    return c.json({ error: 'conflict', message: 'Gig has no valid price configured' }, 409);
  }

  // Only points-based escrow is supported in Phase 1
  // USDC support follows the x402 pattern (see x402 route)
  if (!pricePoints) {
    return c.json({ error: 'not_implemented', message: 'USDC-only gig orders require x402 payment flow' }, 422);
  }

  const orderId = generateGigOrderId();

  // Escrow buyer funds first; if this throws Insufficient balance, we abort
  try {
    await escrowDeductForOrder({ buyerAgentId: agent.id, amount: pricePoints, orderId });
  } catch (err) {
    const e = err as Error;
    if (e.message?.includes('Insufficient balance')) {
      return c.json({ error: 'insufficient_balance', message: e.message }, 402);
    }
    throw err;
  }

  await db.insert(gigOrders).values({
    id: orderId,
    gigId,
    buyerAgentId: agent.id,
    sellerAgentId: gig.creatorAgentId,
    pricePoints: pricePoints.toString(),
    priceUsdc: priceUsdc != null ? priceUsdc.toString() : null,
    paymentMode: 'points',
    status: 'pending',
    requirements,
    revisionCount: '0',
  });

  fireWebhook(gig.creatorAgentId, 'gig_order.placed', {
    order_id: orderId,
    gig_id: gigId,
    buyer_agent_id: agent.id,
    price_points: pricePoints,
  });

  const [order] = await db.select().from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  return c.json(formatOrder(order!), 201);
});

/**
 * GET /v1/gigs/:gigId/orders
 * List orders for a gig (gig creator / seller only).
 */
gigsRouter.get('/:gigId/orders', authMiddleware, async (c) => {
  const agent = c.get('agent');
  const gigId = c.req.param('gigId') ?? '';
  if (!gigId) return c.json({ error: 'invalid_request', message: 'Missing gig id' }, 400);

  const [gig] = await db.select().from(gigs).where(eq(gigs.id, gigId)).limit(1);
  if (!gig) return c.json({ error: 'not_found', message: 'Gig not found' }, 404);
  if (gig.creatorAgentId !== agent.id)
    return c.json({ error: 'forbidden', message: 'Only the gig creator can view all orders' }, 403);

  const list = await db
    .select()
    .from(gigOrders)
    .where(eq(gigOrders.gigId, gigId))
    .orderBy(desc(gigOrders.createdAt));

  return c.json({ orders: list.map(formatOrder) });
});

/**
 * GET /v1/gigs/orders/:orderId
 * Get a single order (buyer or seller).
 */
gigsRouter.get('/orders/:orderId', authMiddleware, async (c) => {
  const agent = c.get('agent');
  const orderId = c.req.param('orderId') ?? '';
  if (!orderId) return c.json({ error: 'invalid_request', message: 'Missing order id' }, 400);

  const [order] = await db.select().from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  if (!order) return c.json({ error: 'not_found', message: 'Order not found' }, 404);
  if (order.buyerAgentId !== agent.id && order.sellerAgentId !== agent.id)
    return c.json({ error: 'forbidden', message: 'Not your order' }, 403);

  return c.json(formatOrder(order));
});

/**
 * POST /v1/gigs/orders/:orderId/accept
 * Seller accepts the order → pending → accepted.
 */
gigsRouter.post('/orders/:orderId/accept', authMiddleware, async (c) => {
  const agent = c.get('agent');
  const orderId = c.req.param('orderId') ?? '';
  if (!orderId) return c.json({ error: 'invalid_request', message: 'Missing order id' }, 400);

  const [order] = await db.select().from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  if (!order) return c.json({ error: 'not_found', message: 'Order not found' }, 404);
  if (order.sellerAgentId !== agent.id)
    return c.json({ error: 'forbidden', message: 'Only the seller can accept orders' }, 403);

  const transitionError = validateTransition(order.status!, 'accepted');
  if (transitionError) return c.json({ error: 'conflict', message: transitionError }, 409);

  await db.update(gigOrders).set({
    status: 'accepted',
    acceptedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(gigOrders.id, orderId));

  fireWebhook(order.buyerAgentId, 'gig_order.accepted', { order_id: orderId, gig_id: order.gigId });
  fireWebhook(agent.id, 'gig_order.accepted', { order_id: orderId, gig_id: order.gigId });

  const [updated] = await db.select().from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  return c.json(formatOrder(updated!), 200);
});

/**
 * POST /v1/gigs/orders/:orderId/deliver
 * Seller delivers work → accepted|revision_requested → delivered.
 */
gigsRouter.post('/orders/:orderId/deliver', authMiddleware, async (c) => {
  const agent = c.get('agent');
  const orderId = c.req.param('orderId') ?? '';
  if (!orderId) return c.json({ error: 'invalid_request', message: 'Missing order id' }, 400);

  const [order] = await db.select().from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  if (!order) return c.json({ error: 'not_found', message: 'Order not found' }, 404);
  if (order.sellerAgentId !== agent.id)
    return c.json({ error: 'forbidden', message: 'Only the seller can deliver' }, 403);

  const transitionError = validateTransition(order.status!, 'delivered');
  if (transitionError) return c.json({ error: 'conflict', message: transitionError }, 409);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400);
  }

  const b = body as Record<string, unknown>;
  const deliveryUrl = typeof b.delivery_url === 'string' ? b.delivery_url.trim() || null : null;
  const deliveryContent = typeof b.delivery_content === 'string' ? b.delivery_content || null : null;
  const deliveryNotes = typeof b.delivery_notes === 'string' ? b.delivery_notes || null : null;

  if (!deliveryUrl && !deliveryContent) {
    return c.json({ error: 'invalid_request', message: 'delivery_url or delivery_content required' }, 400);
  }

  await db.update(gigOrders).set({
    status: 'delivered',
    deliveryUrl,
    deliveryContent,
    deliveryNotes,
    deliveredAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(gigOrders.id, orderId));

  fireWebhook(order.buyerAgentId, 'gig_order.delivered', {
    order_id: orderId,
    gig_id: order.gigId,
    delivery_url: deliveryUrl,
  });

  const [updated] = await db.select().from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  return c.json(formatOrder(updated!), 200);
});

/**
 * POST /v1/gigs/orders/:orderId/complete
 * Buyer approves delivery → delivered → completed.
 * Releases escrowed payment to seller.
 */
gigsRouter.post('/orders/:orderId/complete', authMiddleware, async (c) => {
  const agent = c.get('agent');
  const orderId = c.req.param('orderId') ?? '';
  if (!orderId) return c.json({ error: 'invalid_request', message: 'Missing order id' }, 400);

  const [order] = await db.select().from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  if (!order) return c.json({ error: 'not_found', message: 'Order not found' }, 404);
  if (order.buyerAgentId !== agent.id)
    return c.json({ error: 'forbidden', message: 'Only the buyer can complete an order' }, 403);

  const transitionError = validateTransition(order.status!, 'completed');
  if (transitionError) return c.json({ error: 'conflict', message: transitionError }, 409);

  const price = parseFloat(order.pricePoints ?? '0');
  const { netAmount } = await releaseEscrowForOrder({
    orderId,
    sellerAgentId: order.sellerAgentId,
    totalAmount: price,
  });

  await db.update(gigOrders).set({
    status: 'completed',
    completedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(gigOrders.id, orderId));

  // Update agent stats
  await db.update(agents).set({
    tasksCompleted: sql`tasks_completed + 1`,
    updatedAt: sql`NOW()`,
  }).where(eq(agents.id, order.sellerAgentId));

  await updateReputation(order.sellerAgentId, REPUTATION.TASK_COMPLETED);

  fireWebhook(order.sellerAgentId, 'gig_order.completed', {
    order_id: orderId,
    gig_id: order.gigId,
    earned_points: netAmount,
  });
  fireWebhook(order.buyerAgentId, 'gig_order.completed', {
    order_id: orderId,
    gig_id: order.gigId,
  });

  const [updated] = await db.select().from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  return c.json({ ...formatOrder(updated!), earned_points: netAmount }, 200);
});

/**
 * POST /v1/gigs/orders/:orderId/request-revision
 * Buyer requests changes → delivered → revision_requested.
 */
gigsRouter.post('/orders/:orderId/request-revision', authMiddleware, async (c) => {
  const agent = c.get('agent');
  const orderId = c.req.param('orderId') ?? '';
  if (!orderId) return c.json({ error: 'invalid_request', message: 'Missing order id' }, 400);

  const [order] = await db.select().from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  if (!order) return c.json({ error: 'not_found', message: 'Order not found' }, 404);
  if (order.buyerAgentId !== agent.id)
    return c.json({ error: 'forbidden', message: 'Only the buyer can request revisions' }, 403);

  const transitionError = validateTransition(order.status!, 'revision_requested');
  if (transitionError) return c.json({ error: 'conflict', message: transitionError }, 409);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400);
  }

  const b = body as Record<string, unknown>;
  const feedback = typeof b.feedback === 'string' ? b.feedback.trim() : '';
  if (!feedback) {
    return c.json({ error: 'invalid_request', message: 'feedback required when requesting revision' }, 400);
  }

  const newRevisionCount = (parseInt(order.revisionCount ?? '0', 10) + 1).toString();

  await db.update(gigOrders).set({
    status: 'revision_requested',
    buyerFeedback: feedback,
    revisionCount: newRevisionCount,
    updatedAt: new Date(),
  }).where(eq(gigOrders.id, orderId));

  fireWebhook(order.sellerAgentId, 'gig_order.revision_requested', {
    order_id: orderId,
    gig_id: order.gigId,
    feedback,
    revision_count: parseInt(newRevisionCount, 10),
  });

  const [updated] = await db.select().from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  return c.json(formatOrder(updated!), 200);
});

/**
 * POST /v1/gigs/orders/:orderId/cancel
 * Cancel an order and refund the buyer.
 * Buyer can cancel in: pending state.
 * Seller can cancel in: pending or accepted state.
 */
gigsRouter.post('/orders/:orderId/cancel', authMiddleware, async (c) => {
  const agent = c.get('agent');
  const orderId = c.req.param('orderId') ?? '';
  if (!orderId) return c.json({ error: 'invalid_request', message: 'Missing order id' }, 400);

  const [order] = await db.select().from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  if (!order) return c.json({ error: 'not_found', message: 'Order not found' }, 404);

  const isBuyer = order.buyerAgentId === agent.id;
  const isSeller = order.sellerAgentId === agent.id;
  if (!isBuyer && !isSeller)
    return c.json({ error: 'forbidden', message: 'Not your order' }, 403);

  // Sellers can cancel pending or accepted; buyers can only cancel pending
  const currentStatus = order.status as GigOrderState;
  if (isBuyer && currentStatus !== 'pending') {
    return c.json({ error: 'conflict', message: 'Buyers can only cancel pending orders' }, 409);
  }

  const transitionError = validateTransition(currentStatus, 'cancelled');
  if (transitionError) return c.json({ error: 'conflict', message: transitionError }, 409);

  const price = parseFloat(order.pricePoints ?? '0');
  await refundEscrowForOrder({ buyerAgentId: order.buyerAgentId, amount: price, orderId });

  await db.update(gigOrders).set({
    status: 'cancelled',
    cancelledAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(gigOrders.id, orderId));

  fireWebhook(order.buyerAgentId, 'gig_order.cancelled', {
    order_id: orderId,
    gig_id: order.gigId,
    refund_points: price,
    cancelled_by: agent.id,
  });
  fireWebhook(order.sellerAgentId, 'gig_order.cancelled', {
    order_id: orderId,
    gig_id: order.gigId,
    cancelled_by: agent.id,
  });

  const [updated] = await db.select().from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  return c.json({ ...formatOrder(updated!), refund_points: price }, 200);
});

/**
 * POST /v1/gigs/orders/:orderId/dispute
 * Buyer raises a dispute → delivered → disputed.
 */
gigsRouter.post('/orders/:orderId/dispute', authMiddleware, async (c) => {
  const agent = c.get('agent');
  const orderId = c.req.param('orderId') ?? '';
  if (!orderId) return c.json({ error: 'invalid_request', message: 'Missing order id' }, 400);

  const [order] = await db.select().from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  if (!order) return c.json({ error: 'not_found', message: 'Order not found' }, 404);
  if (order.buyerAgentId !== agent.id)
    return c.json({ error: 'forbidden', message: 'Only the buyer can open a dispute' }, 403);

  const transitionError = validateTransition(order.status!, 'disputed');
  if (transitionError) return c.json({ error: 'conflict', message: transitionError }, 409);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400);
  }

  const b = body as Record<string, unknown>;
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (!reason) {
    return c.json({ error: 'invalid_request', message: 'reason required when opening a dispute' }, 400);
  }

  await db.update(gigOrders).set({
    status: 'disputed',
    buyerFeedback: reason,
    updatedAt: new Date(),
  }).where(eq(gigOrders.id, orderId));

  fireWebhook(order.sellerAgentId, 'gig_order.disputed', {
    order_id: orderId,
    gig_id: order.gigId,
    reason,
  });
  fireWebhook(order.buyerAgentId, 'gig_order.disputed', {
    order_id: orderId,
    gig_id: order.gigId,
  });

  const [updated] = await db.select().from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  return c.json(formatOrder(updated!), 200);
});

// ---------------------------------------------------------------------------
// File Storage
// ---------------------------------------------------------------------------

/**
 * POST /v1/gigs/:id/upload
 * Attach a file (image or PDF) to a gig listing.
 * Accepts multipart/form-data with a "file" field.
 * Replaces any existing attachment.
 *
 * Access: gig creator only, gig must be open.
 */
gigsRouter.post('/:id/upload', authMiddleware, async (c) => {
  const agent = c.get('agent');
  const id = c.req.param('id') ?? '';
  if (!id) return c.json({ error: 'invalid_request', message: 'Missing gig id' }, 400);

  const [gig] = await db.select().from(gigs).where(eq(gigs.id, id)).limit(1);
  if (!gig) return c.json({ error: 'not_found', message: 'Gig not found' }, 404);
  if (gig.creatorAgentId !== agent.id)
    return c.json({ error: 'forbidden', message: 'Not gig creator' }, 403);

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Expected multipart/form-data' }, 400);
  }

  const file = formData.get('file');
  if (!file || !(file instanceof File)) {
    return c.json({ error: 'invalid_request', message: '"file" field required' }, 400);
  }

  const contentType = file.type || 'application/octet-stream';
  if (!(ALLOWED_GIG_MIME_TYPES as readonly string[]).includes(contentType)) {
    return c.json(
      { error: 'invalid_request', message: `File type not allowed. Accepted: ${ALLOWED_GIG_MIME_TYPES.join(', ')}` },
      400,
    );
  }

  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > MAX_GIG_FILE_BYTES) {
    return c.json({ error: 'invalid_request', message: 'File too large (max 5 MB)' }, 400);
  }

  // Delete old file if present
  if (gig.fileStoragePath) {
    await deleteFile(gig.fileStoragePath, BUCKET_GIG_FILES).catch(() => {/* ignore stale cleanup errors */});
  }

  const { path, publicUrl } = await uploadFile(
    BUCKET_GIG_FILES,
    id,
    file.name,
    Buffer.from(buffer),
    contentType,
  );

  await db.update(gigs).set({
    fileStoragePath: path,
    fileUrl: publicUrl ?? null,
    updatedAt: new Date(),
  }).where(eq(gigs.id, id));

  const [updated] = await db.select().from(gigs).where(eq(gigs.id, id)).limit(1);
  return c.json(formatGig(updated!), 200);
});

/**
 * POST /v1/gigs/orders/:orderId/upload
 * Seller uploads a delivery file for an order.
 * Accepts multipart/form-data with a "file" field.
 * The file is stored privately; buyers access it via the signed URL endpoint.
 *
 * Access: order seller only, order must be in accepted or revision_requested state.
 */
gigsRouter.post('/orders/:orderId/upload', authMiddleware, async (c) => {
  const agent = c.get('agent');
  const orderId = c.req.param('orderId') ?? '';
  if (!orderId) return c.json({ error: 'invalid_request', message: 'Missing order id' }, 400);

  const [order] = await db.select().from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  if (!order) return c.json({ error: 'not_found', message: 'Order not found' }, 404);
  if (order.sellerAgentId !== agent.id)
    return c.json({ error: 'forbidden', message: 'Only the seller can upload delivery files' }, 403);

  const allowedUploadStates = ['accepted', 'revision_requested'];
  if (!allowedUploadStates.includes(order.status!)) {
    return c.json(
      { error: 'conflict', message: `File upload only allowed in: ${allowedUploadStates.join(', ')} states` },
      409,
    );
  }

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Expected multipart/form-data' }, 400);
  }

  const file = formData.get('file');
  if (!file || !(file instanceof File)) {
    return c.json({ error: 'invalid_request', message: '"file" field required' }, 400);
  }

  const contentType = file.type || 'application/octet-stream';
  if (!(ALLOWED_ORDER_MIME_TYPES as readonly string[]).includes(contentType)) {
    return c.json(
      { error: 'invalid_request', message: `File type not allowed. Accepted: ${ALLOWED_ORDER_MIME_TYPES.join(', ')}` },
      400,
    );
  }

  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > MAX_ORDER_FILE_BYTES) {
    return c.json({ error: 'invalid_request', message: 'File too large (max 50 MB)' }, 400);
  }

  // Delete old delivery file if present
  if (order.deliveryFileKey) {
    await deleteFile(order.deliveryFileKey, BUCKET_ORDER_FILES).catch(() => {/* ignore */});
  }

  const { path } = await uploadFile(
    BUCKET_ORDER_FILES,
    orderId,
    file.name,
    Buffer.from(buffer),
    contentType,
  );

  await db.update(gigOrders).set({
    deliveryFileKey: path,
    updatedAt: new Date(),
  }).where(eq(gigOrders.id, orderId));

  return c.json({ success: true, message: 'Delivery file uploaded. Use the deliver endpoint to submit the order.' }, 200);
});

/**
 * GET /v1/gigs/orders/:orderId/delivery-file
 * Get a short-lived signed URL for the delivery file.
 * Access: buyer or seller of the order.
 */
gigsRouter.get('/orders/:orderId/delivery-file', authMiddleware, async (c) => {
  const agent = c.get('agent');
  const orderId = c.req.param('orderId') ?? '';
  if (!orderId) return c.json({ error: 'invalid_request', message: 'Missing order id' }, 400);

  const [order] = await db.select().from(gigOrders).where(eq(gigOrders.id, orderId)).limit(1);
  if (!order) return c.json({ error: 'not_found', message: 'Order not found' }, 404);
  if (order.buyerAgentId !== agent.id && order.sellerAgentId !== agent.id)
    return c.json({ error: 'forbidden', message: 'Not your order' }, 403);

  if (!order.deliveryFileKey) {
    return c.json({ error: 'not_found', message: 'No delivery file attached to this order' }, 404);
  }

  const signedUrl = await getSignedUrl(order.deliveryFileKey, 3600);
  return c.json({ signed_url: signedUrl, expires_in: 3600 }, 200);
});

/**
 * GET /v1/gigs/orders/my
 * List all orders for the authenticated agent (as buyer or seller).
 */
gigsRouter.get('/orders/my', authMiddleware, async (c) => {
  const agent = c.get('agent');
  const role = c.req.query('role') ?? 'all'; // 'buyer' | 'seller' | 'all'
  const status = c.req.query('status');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 100);
  const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);

  const conditions = [];
  if (role === 'buyer') {
    conditions.push(eq(gigOrders.buyerAgentId, agent.id));
  } else if (role === 'seller') {
    conditions.push(eq(gigOrders.sellerAgentId, agent.id));
  } else {
    conditions.push(sql`(buyer_agent_id = ${agent.id} OR seller_agent_id = ${agent.id})`);
  }
  if (status) conditions.push(eq(gigOrders.status, status));

  const list = await db
    .select()
    .from(gigOrders)
    .where(and(...conditions))
    .orderBy(desc(gigOrders.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json({ orders: list.map(formatOrder), limit, offset });
});

// ---------------------------------------------------------------------------
// Private Messaging (Gig Message Threads)
// ---------------------------------------------------------------------------

/**
 * Helper: verify the caller is a party on the gig (creator or a buyer who has placed an order).
 * Returns { gig, otherPartyId } or an error code.
 */
async function getGigParty(
  gigId: string,
  agentId: string,
): Promise<
  | { gig: typeof gigs.$inferSelect; otherPartyId: string; error: null }
  | { gig: null; otherPartyId: null; error: 'not_found' | 'forbidden' | 'no_order' }
> {
  const [gig] = await db.select().from(gigs).where(eq(gigs.id, gigId)).limit(1);
  if (!gig) return { gig: null, otherPartyId: null, error: 'not_found' };

  // Gig creator can always access messages
  if (gig.creatorAgentId === agentId) {
    // Any buyer who has an order (to find the conversation partner)
    const [order] = await db
      .select({ buyerAgentId: gigOrders.buyerAgentId })
      .from(gigOrders)
      .where(eq(gigOrders.gigId, gigId))
      .orderBy(desc(gigOrders.createdAt))
      .limit(1);
    return { gig, otherPartyId: order?.buyerAgentId ?? agentId, error: null };
  }

  // Buyer must have an active or historical order on this gig
  const [order] = await db
    .select({ buyerAgentId: gigOrders.buyerAgentId })
    .from(gigOrders)
    .where(and(eq(gigOrders.gigId, gigId), eq(gigOrders.buyerAgentId, agentId)))
    .limit(1);

  if (!order) return { gig: null, otherPartyId: null, error: 'no_order' };
  return { gig, otherPartyId: gig.creatorAgentId, error: null };
}

/**
 * POST /v1/gigs/:gigId/messages
 * Send a private message on a gig thread (creator ↔ buyer).
 *
 * Access: gig creator OR any agent with an order on this gig.
 * The recipient is automatically determined (the other party).
 */
gigsRouter.post('/:gigId/messages', authMiddleware, async (c) => {
  const agent = c.get('agent');
  const gigId = c.req.param('gigId') ?? '';
  if (!gigId) return c.json({ error: 'invalid_request', message: 'Missing gig id' }, 400);

  const { gig, otherPartyId, error } = await getGigParty(gigId, agent.id);
  if (error === 'not_found') return c.json({ error: 'not_found', message: 'Gig not found' }, 404);
  if (error === 'forbidden') return c.json({ error: 'forbidden', message: 'Access denied' }, 403);
  if (error === 'no_order') {
    return c.json({ error: 'forbidden', message: 'You must have placed an order to message the gig creator' }, 403);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400);
  }

  const b = body as Record<string, unknown>;
  const content = typeof b.content === 'string' ? b.content.trim() : '';
  if (!content || content.length > 4000) {
    return c.json({ error: 'invalid_request', message: 'content required (max 4000 characters)' }, 400);
  }

  const recipientId = otherPartyId!;
  const msgId = generateOrderMessageId();
  await db.insert(orderMessages).values({
    id: msgId,
    gigId,
    senderAgentId: agent.id,
    recipientAgentId: recipientId,
    content,
  });

  const [msg] = await db.select().from(orderMessages).where(eq(orderMessages.id, msgId)).limit(1);

  // Notify the other party
  fireWebhook(recipientId, 'gig.message', {
    gig_id: gigId,
    message_id: msgId,
    sender_agent_id: agent.id,
    content_preview: content.slice(0, 200),
  });

  return c.json({
    id: msg!.id,
    gig_id: msg!.gigId,
    sender_agent_id: msg!.senderAgentId,
    recipient_agent_id: msg!.recipientAgentId,
    content: msg!.content,
    file_url: msg!.fileUrl ?? null,
    file_name: msg!.fileName ?? null,
    created_at: msg!.createdAt?.toISOString(),
  }, 201);
});

/**
 * GET /v1/gigs/:gigId/messages
 * List messages in a gig thread (creator or buyer with an order).
 * Returns messages where the caller is either sender or recipient.
 */
gigsRouter.get('/:gigId/messages', authMiddleware, async (c) => {
  const agent = c.get('agent');
  const gigId = c.req.param('gigId') ?? '';
  if (!gigId) return c.json({ error: 'invalid_request', message: 'Missing gig id' }, 400);

  const { error } = await getGigParty(gigId, agent.id);
  if (error === 'not_found') return c.json({ error: 'not_found', message: 'Gig not found' }, 404);
  if (error === 'forbidden') return c.json({ error: 'forbidden', message: 'Access denied' }, 403);
  if (error === 'no_order') {
    return c.json({ error: 'forbidden', message: 'You must have placed an order to view messages' }, 403);
  }

  const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10) || 100, 200);
  const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);

  // Fetch all messages involving this agent on this gig
  const msgs = await db
    .select()
    .from(orderMessages)
    .where(
      and(
        eq(orderMessages.gigId, gigId),
        or(
          eq(orderMessages.senderAgentId, agent.id),
          eq(orderMessages.recipientAgentId, agent.id),
        ),
      ),
    )
    .orderBy(desc(orderMessages.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json({
    gig_id: gigId,
    messages: msgs.map((m) => ({
      id: m.id,
      gig_id: m.gigId,
      sender_agent_id: m.senderAgentId,
      recipient_agent_id: m.recipientAgentId,
      content: m.content,
      file_url: m.fileUrl ?? null,
      file_name: m.fileName ?? null,
      file_size: m.fileSize ?? null,
      file_mime_type: m.fileMimeType ?? null,
      created_at: m.createdAt?.toISOString(),
    })),
    limit,
    offset,
  });
});
