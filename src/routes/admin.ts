/**
 * Admin routes — protected by ADMIN_SECRET env variable.
 * Mount at /v1/admin/* in src/index.ts
 *
 * Authentication: Authorization: Bearer <ADMIN_SECRET>
 */

import { Hono } from 'hono';
import crypto from 'node:crypto';
import { desc, eq, and, sql, count, sum, gte } from 'drizzle-orm';
import { db, dbDirect } from '../db/pool.js';
import {
  agents,
  tasks,
  transactions,
  x402Payments,
  gigs,
  gigOrders,
  contentAuditLog,
} from '../db/schema/index.js';
import { runDailyEmission } from '../services/emissionService.js';
import { releaseEscrowForOrder, refundEscrowForOrder } from '../lib/transfer.js';
import { fireWebhook } from '../lib/webhooks.js';
import { updateReputation, REPUTATION } from '../lib/reputation.js';

export const adminRouter = new Hono();

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

adminRouter.use('*', async (c, next) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    return c.json({ error: 'unavailable', message: 'Admin API not configured — set ADMIN_SECRET' }, 503);
  }

  const auth = c.req.header('Authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null;

  // H3: Use timing-safe comparison to prevent timing attacks
  let tokenValid = false;
  if (token) {
    try {
      tokenValid = crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret));
    } catch {
      // Length mismatch throws — treat as invalid
      tokenValid = false;
    }
  }
  if (!tokenValid) {
    return c.json({ error: 'forbidden', message: 'Invalid or missing admin token' }, 403);
  }

  await next();
});

// ---------------------------------------------------------------------------
// Helper: parse pagination query params
// ---------------------------------------------------------------------------
function parsePagination(query: Record<string, string>) {
  const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? '50', 10) || 50));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

// ---------------------------------------------------------------------------
// GET /v1/admin/transactions
// ---------------------------------------------------------------------------
adminRouter.get('/transactions', async (c) => {
  const query = c.req.query() as Record<string, string>;
  const { page, limit, offset } = parsePagination(query);
  const { currency, agent_id, type } = query;

  // Build dynamic WHERE conditions
  const conditions = [];
  if (currency) conditions.push(eq(transactions.currency, currency));
  if (type) conditions.push(eq(transactions.type, type));
  if (agent_id) {
    conditions.push(
      sql`(${transactions.fromAgentId} = ${agent_id} OR ${transactions.toAgentId} = ${agent_id})`,
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, totalResult] = await Promise.all([
    db
      .select({
        id: transactions.id,
        from_agent_id: transactions.fromAgentId,
        from_agent_name: sql<string>`fa.name`,
        to_agent_id: transactions.toAgentId,
        to_agent_name: sql<string>`ta.name`,
        amount: transactions.amount,
        currency: transactions.currency,
        type: transactions.type,
        task_id: transactions.taskId,
        task_title: sql<string>`t.title`,
        memo: transactions.memo,
        created_at: transactions.createdAt,
      })
      .from(transactions)
      .leftJoin(sql`agents fa`, sql`fa.id = ${transactions.fromAgentId}`)
      .leftJoin(sql`agents ta`, sql`ta.id = ${transactions.toAgentId}`)
      .leftJoin(sql`tasks t`, sql`t.id = ${transactions.taskId}`)
      .where(where)
      .orderBy(desc(transactions.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: count() })
      .from(transactions)
      .where(where),
  ]);

  return c.json({
    data: rows.map(r => ({
      ...r,
      id: r.id.toString(),
      amount: parseFloat(r.amount ?? '0'),
      created_at: r.created_at?.toISOString(),
    })),
    pagination: { page, limit, total: totalResult[0]?.count ?? 0 },
  });
});

// ---------------------------------------------------------------------------
// GET /v1/admin/x402-payments
// ---------------------------------------------------------------------------
adminRouter.get('/x402-payments', async (c) => {
  const query = c.req.query() as Record<string, string>;
  const { page, limit, offset } = parsePagination(query);
  const { network } = query;

  const conditions = [];
  if (network) conditions.push(eq(x402Payments.network, network));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, totalResult] = await Promise.all([
    db
      .select({
        id: x402Payments.id,
        task_id: x402Payments.taskId,
        task_title: sql<string>`t.title`,
        payer_address: x402Payments.payerAddress,
        recipient_address: x402Payments.recipientAddress,
        amount_usdc: x402Payments.amountUsdc,
        tx_hash: x402Payments.txHash,
        network: x402Payments.network,
        payment_type: x402Payments.paymentType,
        created_at: x402Payments.createdAt,
      })
      .from(x402Payments)
      .leftJoin(sql`tasks t`, sql`t.id = ${x402Payments.taskId}`)
      .where(where)
      .orderBy(desc(x402Payments.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: count() })
      .from(x402Payments)
      .where(where),
  ]);

  function baseExplorerUrl(network: string): string {
    if (network === 'eip155:8453') return 'https://basescan.org/tx/';
    return 'https://sepolia.basescan.org/tx/';
  }

  return c.json({
    data: rows.map(r => ({
      ...r,
      amount_usdc: parseFloat(r.amount_usdc ?? '0'),
      basescan_url: `${baseExplorerUrl(r.network ?? '')}${r.tx_hash}`,
      created_at: r.created_at?.toISOString(),
    })),
    pagination: { page, limit, total: totalResult[0]?.count ?? 0 },
  });
});

// ---------------------------------------------------------------------------
// GET /v1/admin/agents
// ---------------------------------------------------------------------------
adminRouter.get('/agents', async (c) => {
  const query = c.req.query() as Record<string, string>;
  const { page, limit, offset } = parsePagination(query);
  const { status } = query;

  const conditions = [];
  if (status) conditions.push(eq(agents.status, status));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, totalResult] = await Promise.all([
    db
      .select({
        id: agents.id,
        name: agents.name,
        description: agents.description,
        owner_twitter: agents.ownerTwitter,
        status: agents.status,
        balance_points: agents.balancePoints,
        balance_usdc: agents.balanceUsdc,
        tasks_created: agents.tasksCreated,
        tasks_completed: agents.tasksCompleted,
        reputation_score: agents.reputationScore,
        success_rate: agents.successRate,
        evm_address: agents.evmAddress,
        last_api_call_at: agents.lastApiCallAt,
        verified_at: agents.verifiedAt,
        created_at: agents.createdAt,
      })
      .from(agents)
      .where(where)
      .orderBy(desc(agents.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: count() }).from(agents).where(where),
  ]);

  return c.json({
    data: rows.map(r => ({
      ...r,
      balance_points: parseFloat(r.balance_points ?? '0'),
      balance_usdc: parseFloat(r.balance_usdc ?? '0'),
      reputation_score: parseFloat(r.reputation_score ?? '0'),
      success_rate: parseFloat(r.success_rate ?? '0'),
      last_api_call_at: r.last_api_call_at?.toISOString() ?? null,
      verified_at: r.verified_at?.toISOString() ?? null,
      created_at: r.created_at?.toISOString(),
    })),
    pagination: { page, limit, total: totalResult[0]?.count ?? 0 },
  });
});

// ---------------------------------------------------------------------------
// GET /v1/admin/tasks
// ---------------------------------------------------------------------------
adminRouter.get('/tasks', async (c) => {
  const query = c.req.query() as Record<string, string>;
  const { page, limit, offset } = parsePagination(query);
  const { status, payment_mode, network } = query;

  const conditions = [];
  if (status) conditions.push(eq(tasks.status, status));
  if (payment_mode) conditions.push(eq(tasks.paymentMode, payment_mode));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  function baseExplorerUrl(network?: string): string {
    if (network === 'eip155:8453') return 'https://basescan.org/tx/';
    return 'https://sepolia.basescan.org/tx/';
  }

  const [rows, totalResult] = await Promise.all([
    db
      .select({
        id: tasks.id,
        title: tasks.title,
        category: tasks.category,
        status: tasks.status,
        price_points: tasks.pricePoints,
        price_usdc: tasks.priceUsdc,
        payment_mode: tasks.paymentMode,
        creator_agent_id: tasks.creatorAgentId,
        creator_name: sql<string>`ca.name`,
        executor_agent_id: tasks.executorAgentId,
        executor_name: sql<string>`ea.name`,
        escrow_tx_hash: tasks.escrowTxHash,
        system_task: tasks.systemTask,
        deadline: tasks.deadline,
        created_at: tasks.createdAt,
      })
      .from(tasks)
      .leftJoin(sql`agents ca`, sql`ca.id = ${tasks.creatorAgentId}`)
      .leftJoin(sql`agents ea`, sql`ea.id = ${tasks.executorAgentId}`)
      .where(where)
      .orderBy(desc(tasks.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: count() }).from(tasks).where(where),
  ]);

  const envNetwork = process.env.BASE_NETWORK ?? 'eip155:84532';

  return c.json({
    data: rows.map(r => ({
      ...r,
      price_points: r.price_points ? parseFloat(r.price_points) : null,
      price_usdc: r.price_usdc ? parseFloat(r.price_usdc) : null,
      basescan_url: r.escrow_tx_hash
        ? `${baseExplorerUrl(network ?? envNetwork)}${r.escrow_tx_hash}`
        : null,
      deadline: r.deadline?.toISOString() ?? null,
      created_at: r.created_at?.toISOString(),
    })),
    pagination: { page, limit, total: totalResult[0]?.count ?? 0 },
  });
});

// ---------------------------------------------------------------------------
// GET /v1/admin/stats
// ---------------------------------------------------------------------------
adminRouter.get('/stats', async (c) => {
  const [
    agentStats,
    taskStats,
    txStats,
    shellCirculation,
    usdcByNetwork,
    platformFees,
    x402Stats,
  ] = await Promise.all([
    // Agent counts
    db
      .select({
        total: count(),
        verified: sql<number>`count(*) filter (where status = 'verified')`,
        suspended: sql<number>`count(*) filter (where status = 'suspended')`,
      })
      .from(agents),

    // Task counts by status
    db
      .select({
        total: count(),
        open: sql<number>`count(*) filter (where status = 'open')`,
        in_progress: sql<number>`count(*) filter (where status = 'in_progress')`,
        completed: sql<number>`count(*) filter (where status = 'completed')`,
        cancelled: sql<number>`count(*) filter (where status = 'cancelled')`,
        usdc_tasks: sql<number>`count(*) filter (where payment_mode = 'usdc')`,
        points_tasks: sql<number>`count(*) filter (where payment_mode = 'points')`,
      })
      .from(tasks),

    // Transaction counts and volume
    db
      .select({
        total: count(),
        points_volume: sql<string>`coalesce(sum(amount) filter (where currency = 'points'), 0)`,
        usdc_volume: sql<string>`coalesce(sum(amount) filter (where currency = 'usdc'), 0)`,
      })
      .from(transactions),

    // Total Shells in circulation (sum of all agent balances)
    db
      .select({
        total_shells: sql<string>`coalesce(sum(balance_points), 0)`,
      })
      .from(agents),

    // USDC volume by network from x402_payments
    db
      .select({
        network: x402Payments.network,
        total_volume: sql<string>`coalesce(sum(amount_usdc), 0)`,
        payment_count: count(),
      })
      .from(x402Payments)
      .groupBy(x402Payments.network),

    // Platform fees collected
    db
      .select({
        points_fees: sql<string>`coalesce(sum(amount) filter (where type = 'platform_fee' and currency = 'points'), 0)`,
        usdc_fees: sql<string>`coalesce(sum(amount) filter (where type = 'platform_fee' and currency = 'usdc'), 0)`,
      })
      .from(transactions),

    // x402 payments total
    db
      .select({
        total: count(),
        total_volume: sql<string>`coalesce(sum(amount_usdc), 0)`,
      })
      .from(x402Payments),
  ]);

  const usdcNetworkMap: Record<string, { volume: number; count: number }> = {};
  for (const row of usdcByNetwork) {
    usdcNetworkMap[row.network ?? 'unknown'] = {
      volume: parseFloat(row.total_volume ?? '0'),
      count: row.payment_count,
    };
  }

  return c.json({
    agents: {
      total: agentStats[0]?.total ?? 0,
      verified: Number(agentStats[0]?.verified ?? 0),
      suspended: Number(agentStats[0]?.suspended ?? 0),
    },
    tasks: {
      total: taskStats[0]?.total ?? 0,
      open: Number(taskStats[0]?.open ?? 0),
      in_progress: Number(taskStats[0]?.in_progress ?? 0),
      completed: Number(taskStats[0]?.completed ?? 0),
      cancelled: Number(taskStats[0]?.cancelled ?? 0),
      usdc_tasks: Number(taskStats[0]?.usdc_tasks ?? 0),
      points_tasks: Number(taskStats[0]?.points_tasks ?? 0),
    },
    transactions: {
      total: txStats[0]?.total ?? 0,
      points_volume: parseFloat(txStats[0]?.points_volume ?? '0'),
      usdc_volume: parseFloat(txStats[0]?.usdc_volume ?? '0'),
    },
    shells_in_circulation: parseFloat(shellCirculation[0]?.total_shells ?? '0'),
    x402_payments: {
      total: x402Stats[0]?.total ?? 0,
      total_usdc_volume: parseFloat(x402Stats[0]?.total_volume ?? '0'),
      by_network: usdcNetworkMap,
    },
    platform_fees: {
      points: parseFloat(platformFees[0]?.points_fees ?? '0'),
      usdc: parseFloat(platformFees[0]?.usdc_fees ?? '0'),
    },
  });
});

// ---------------------------------------------------------------------------
// POST /v1/admin/economy/run-emission
// ---------------------------------------------------------------------------

/**
 * POST /v1/admin/economy/run-emission
 * Manually trigger the daily emission run (for testing / backfill).
 * Protected by ADMIN_SECRET.
 */
adminRouter.post('/economy/run-emission', async (c) => {
  try {
    const result = await runDailyEmission();
    return c.json({
      ok: true,
      run_at: result.runAt.toISOString(),
      verified_agent_count: result.verifiedAgentCount,
      base_emission: result.baseEmission,
      eligible_agents: result.eligibleAgents,
      total_shells_emitted: result.totalShellsEmitted,
      skipped_cap: result.skippedCap,
      skipped_inactive: result.skippedInactive,
    });
  } catch (err) {
    const e = err as Error;
    console.error('[Admin] run-emission failed:', e);
    return c.json({ error: 'emission_failed', message: e.message }, 500);
  }
});

// GET /v1/admin/gig-orders
// List gig orders with optional ?status= filter. Useful for viewing disputed orders.
// ---------------------------------------------------------------------------
adminRouter.get('/gig-orders', async (c) => {
  const query = c.req.query() as Record<string, string>;
  const { page, limit, offset } = parsePagination(query);
  const { status } = query;

  const conditions = [];
  if (status) conditions.push(eq(gigOrders.status, status));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, totalResult] = await Promise.all([
    db
      .select({
        id: gigOrders.id,
        gig_id: gigOrders.gigId,
        gig_title: sql<string>`g.title`,
        buyer_agent_id: gigOrders.buyerAgentId,
        buyer_name: sql<string>`ba.name`,
        seller_agent_id: gigOrders.sellerAgentId,
        seller_name: sql<string>`sa.name`,
        price_points: gigOrders.pricePoints,
        price_usdc: gigOrders.priceUsdc,
        payment_mode: gigOrders.paymentMode,
        status: gigOrders.status,
        requirements: gigOrders.requirements,
        buyer_feedback: gigOrders.buyerFeedback,
        dispute_resolution: gigOrders.disputeResolution,
        revision_count: gigOrders.revisionCount,
        accepted_at: gigOrders.acceptedAt,
        delivered_at: gigOrders.deliveredAt,
        completed_at: gigOrders.completedAt,
        cancelled_at: gigOrders.cancelledAt,
        created_at: gigOrders.createdAt,
        updated_at: gigOrders.updatedAt,
      })
      .from(gigOrders)
      .leftJoin(sql`gigs g`, sql`g.id = ${gigOrders.gigId}`)
      .leftJoin(sql`agents ba`, sql`ba.id = ${gigOrders.buyerAgentId}`)
      .leftJoin(sql`agents sa`, sql`sa.id = ${gigOrders.sellerAgentId}`)
      .where(where)
      .orderBy(desc(gigOrders.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: count() }).from(gigOrders).where(where),
  ]);

  return c.json({
    data: rows.map(r => ({
      ...r,
      price_points: r.price_points ? parseFloat(r.price_points) : null,
      price_usdc: r.price_usdc ? parseFloat(r.price_usdc) : null,
      revision_count: parseInt(r.revision_count ?? '0', 10),
      accepted_at: r.accepted_at?.toISOString() ?? null,
      delivered_at: r.delivered_at?.toISOString() ?? null,
      completed_at: r.completed_at?.toISOString() ?? null,
      cancelled_at: r.cancelled_at?.toISOString() ?? null,
      created_at: r.created_at?.toISOString(),
      updated_at: r.updated_at?.toISOString(),
    })),
    pagination: { page, limit, total: totalResult[0]?.count ?? 0 },
  });
});

// ---------------------------------------------------------------------------
// POST /v1/admin/gig-orders/:orderId/resolve-dispute
// Resolve a disputed gig order. Admin only.
// Body: { resolution: "seller_wins" | "buyer_wins", notes: string }
// ---------------------------------------------------------------------------
adminRouter.post('/gig-orders/:orderId/resolve-dispute', async (c) => {
  const orderId = c.req.param('orderId') ?? '';
  if (!orderId) return c.json({ error: 'invalid_request', message: 'Missing order id' }, 400);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400);
  }

  const b = body as Record<string, unknown>;
  const resolution = typeof b.resolution === 'string' ? b.resolution : '';
  const notes = typeof b.notes === 'string' ? b.notes.trim() : '';

  if (resolution !== 'seller_wins' && resolution !== 'buyer_wins') {
    return c.json(
      { error: 'invalid_request', message: 'resolution must be "seller_wins" or "buyer_wins"' },
      400,
    );
  }
  if (!notes) {
    return c.json({ error: 'invalid_request', message: 'notes is required' }, 400);
  }

  // Fetch order — used for seller/buyer IDs, payment mode, and 404 check.
  const [order] = await db
    .select()
    .from(gigOrders)
    .where(eq(gigOrders.id, orderId))
    .limit(1);

  if (!order) return c.json({ error: 'not_found', message: 'Order not found' }, 404);

  // Select the correct escrow amount based on payment mode.
  // An order placed in USDC mode stores the price in priceUsdc; points orders use pricePoints.
  const price = order.paymentMode === 'usdc'
    ? parseFloat(order.priceUsdc ?? '0')
    : parseFloat(order.pricePoints ?? '0');

  if (resolution === 'seller_wins') {
    // -------------------------------------------------------------------------
    // seller_wins path
    //
    // Strategy: atomically update order status + seller stats inside a DB
    // transaction, then call the escrow function LAST. This ensures:
    //   1. The "check + update" is atomic at the DB level → no double-resolution
    //      race condition (two concurrent admins both reading 'disputed').
    //   2. No money moves until all DB writes have committed → if a DB write
    //      fails the transaction rolls back and no funds are transferred.
    // -------------------------------------------------------------------------
    const now = new Date();

    const txResult = await dbDirect.transaction(async (tx) => {
      // Atomic status guard: only succeeds if order is still 'disputed'.
      const updated = await tx
        .update(gigOrders)
        .set({
          status: 'completed',
          disputeResolution: notes,
          completedAt: now,
          updatedAt: now,
        })
        .where(and(eq(gigOrders.id, orderId), eq(gigOrders.status, 'disputed')))
        .returning({ id: gigOrders.id, completedAt: gigOrders.completedAt });

      if (updated.length === 0) return null;

      // Update seller stats inside the same transaction.
      await tx
        .update(agents)
        .set({ tasksCompleted: sql`tasks_completed + 1`, updatedAt: sql`NOW()` })
        .where(eq(agents.id, order.sellerAgentId));

      return updated[0];
    });

    if (!txResult) {
      return c.json(
        { error: 'conflict', message: 'Order is not disputed or was already resolved' },
        409,
      );
    }

    // Escrow is called AFTER the DB transaction commits so that a DB failure
    // never leaves money in a moved state with the order still disputed.
    const { netAmount } = await releaseEscrowForOrder({
      orderId,
      sellerAgentId: order.sellerAgentId,
      totalAmount: price,
    });

    // Reputation update is non-critical; run after escrow.
    await updateReputation(order.sellerAgentId, REPUTATION.TASK_COMPLETED);

    // Webhooks are fire-and-forget — delivery failures are non-fatal.
    const disputePayload = { order_id: orderId, gig_id: order.gigId, resolution: 'seller_wins', notes };
    void fireWebhook(order.sellerAgentId, 'gig_order.dispute_resolved', { ...disputePayload, earned_points: netAmount });
    void fireWebhook(order.buyerAgentId, 'gig_order.dispute_resolved', disputePayload);

    return c.json({
      id: orderId,
      status: 'completed',
      resolution: 'seller_wins',
      notes,
      earned_points: netAmount,
      completed_at: txResult.completedAt?.toISOString() ?? null,
    }, 200);

  } else {
    // -------------------------------------------------------------------------
    // buyer_wins path
    //
    // Same strategy: atomic DB update first, escrow last.
    // -------------------------------------------------------------------------
    const now = new Date();

    const txResult = await dbDirect.transaction(async (tx) => {
      const updated = await tx
        .update(gigOrders)
        .set({
          status: 'cancelled',
          disputeResolution: notes,
          cancelledAt: now,
          updatedAt: now,
        })
        .where(and(eq(gigOrders.id, orderId), eq(gigOrders.status, 'disputed')))
        .returning({ id: gigOrders.id, cancelledAt: gigOrders.cancelledAt });

      if (updated.length === 0) return null;

      return updated[0];
    });

    if (!txResult) {
      return c.json(
        { error: 'conflict', message: 'Order is not disputed or was already resolved' },
        409,
      );
    }

    // Escrow refund called AFTER the DB transaction commits.
    await refundEscrowForOrder({
      buyerAgentId: order.buyerAgentId,
      amount: price,
      orderId,
    });

    // Webhooks are fire-and-forget — delivery failures are non-fatal.
    const disputePayload = { order_id: orderId, gig_id: order.gigId, resolution: 'buyer_wins', notes };
    void fireWebhook(order.buyerAgentId, 'gig_order.dispute_resolved', { ...disputePayload, refund_points: price });
    void fireWebhook(order.sellerAgentId, 'gig_order.dispute_resolved', disputePayload);

    return c.json({
      id: orderId,
      status: 'cancelled',
      resolution: 'buyer_wins',
      notes,
      refund_points: price,
      cancelled_at: txResult.cancelledAt?.toISOString() ?? null,
    }, 200);
  }
});

// ---------------------------------------------------------------------------
// GET /v1/admin/content-audit
// Paginated content audit log with optional filters.
//
// Query params:
//   agent_id    — filter by agent
//   severity    — 'info' | 'warning' | 'critical'
//   source_type — 'task' | 'bid' | 'submission' | 'message' | 'gig_delivery'
//   since       — ISO date string (inclusive)
//   page        — 1-based page number (default 1)
//   limit       — results per page (default 50, max 100)
// ---------------------------------------------------------------------------
adminRouter.get('/content-audit', async (c) => {
  const query = c.req.query() as Record<string, string>;
  const { page, limit, offset } = parsePagination(query);

  const conditions = [];
  if (query.agent_id) conditions.push(eq(contentAuditLog.agentId, query.agent_id));
  if (query.severity) conditions.push(eq(contentAuditLog.severity, query.severity));
  if (query.source_type) conditions.push(eq(contentAuditLog.sourceType, query.source_type));
  if (query.since) {
    const sinceDate = new Date(query.since);
    if (!isNaN(sinceDate.getTime())) {
      conditions.push(gte(contentAuditLog.createdAt, sinceDate));
    }
  }

  const whereClause = conditions.length ? and(...conditions) : undefined;

  const rows = whereClause
    ? await db
        .select()
        .from(contentAuditLog)
        .where(whereClause)
        .orderBy(desc(contentAuditLog.createdAt))
        .limit(limit)
        .offset(offset)
    : await db
        .select()
        .from(contentAuditLog)
        .orderBy(desc(contentAuditLog.createdAt))
        .limit(limit)
        .offset(offset);

  return c.json({
    audit_log: rows.map((r) => ({
      id: r.id,
      event_type: r.eventType,
      source_type: r.sourceType,
      source_id: r.sourceId,
      agent_id: r.agentId,
      trust_tier: r.trustTier,
      pattern: r.pattern,
      content_hash: r.contentHash,
      severity: r.severity,
      created_at: r.createdAt?.toISOString(),
    })),
    page,
    limit,
    offset,
  });
});

// ---------------------------------------------------------------------------
// GET /v1/admin/content-audit/alerts
// Returns agents exceeding alert thresholds:
//   - >10 'critical' events in the last 1 hour
//   - >50 'warning' events in the last 24 hours
//
// Auto-suspend is NOT performed automatically — this endpoint surfaces agents
// that require manual review. The threshold-based suspend flow should be
// implemented as a separate manual operation after human review of the audit log.
// ---------------------------------------------------------------------------
adminRouter.get('/content-audit/alerts', async (c) => {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Agents with >10 critical events in last 1 hour
  const criticalAlerts = await db
    .select({
      agentId: contentAuditLog.agentId,
      count: count(),
    })
    .from(contentAuditLog)
    .where(
      and(
        eq(contentAuditLog.severity, 'critical'),
        gte(contentAuditLog.createdAt, oneHourAgo),
      ),
    )
    .groupBy(contentAuditLog.agentId)
    .having(sql`count(*) > 10`);

  // Agents with >50 warning events in last 24 hours
  const warningAlerts = await db
    .select({
      agentId: contentAuditLog.agentId,
      count: count(),
    })
    .from(contentAuditLog)
    .where(
      and(
        eq(contentAuditLog.severity, 'warning'),
        gte(contentAuditLog.createdAt, oneDayAgo),
      ),
    )
    .groupBy(contentAuditLog.agentId)
    .having(sql`count(*) > 50`);

  return c.json({
    /**
     * NOTE: Automatic suspension is out of scope.
     * These agents should be reviewed manually before any action is taken.
     * Suspend via PATCH /v1/admin/agents/:id { status: 'suspended' } after review.
     */
    critical_threshold: {
      description: '>10 critical events in the last 1 hour',
      window_start: oneHourAgo.toISOString(),
      agents: criticalAlerts.map((a) => ({ agent_id: a.agentId, count: Number(a.count) })),
    },
    warning_threshold: {
      description: '>50 warning events in the last 24 hours',
      window_start: oneDayAgo.toISOString(),
      agents: warningAlerts.map((a) => ({ agent_id: a.agentId, count: Number(a.count) })),
    },
    generated_at: now.toISOString(),
  });
});
