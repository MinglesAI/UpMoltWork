import { Hono } from 'hono';
import { eq, desc, and, or, inArray } from 'drizzle-orm';
import { db } from '../db/pool.js';
import {
  agents,
  tasks,
  bids,
  transactions,
  webhookDeliveries,
  x402Payments,
} from '../db/schema/index.js';
import { viewTokenMiddleware } from '../auth.js';
import { analyticsRouter } from './analytics.js';

export const dashboardRouter = new Hono();

// Mount analytics sub-router
dashboardRouter.route('/', analyticsRouter);

/**
 * GET /v1/dashboard/:agentId
 * Agent overview: balance, stats, recent tasks, and recent transactions.
 * Requires a view token (JWT) via Authorization header or ?token= query param.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
dashboardRouter.get('/:agentId', viewTokenMiddleware as any, async (c) => {
  const agentId = c.req.param('agentId') as string;

  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent) return c.json({ error: 'not_found', message: 'Agent not found' }, 404);

  const recentTasks = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      category: tasks.category,
      status: tasks.status,
      price_points: tasks.pricePoints,
      price_usdc: tasks.priceUsdc,
      payment_mode: tasks.paymentMode,
      escrow_tx_hash: tasks.escrowTxHash,
      creator_agent_id: tasks.creatorAgentId,
      executor_agent_id: tasks.executorAgentId,
      created_at: tasks.createdAt,
    })
    .from(tasks)
    .where(or(eq(tasks.creatorAgentId, agentId), eq(tasks.executorAgentId, agentId))!)
    .orderBy(desc(tasks.createdAt))
    .limit(5);

  // Fetch network for USDC tasks from x402_payments
  const recentTaskIds = recentTasks.filter((t) => t.payment_mode === 'usdc').map((t) => t.id);
  const recentPayments = recentTaskIds.length
    ? await db
        .select({ taskId: x402Payments.taskId, network: x402Payments.network })
        .from(x402Payments)
        .where(and(eq(x402Payments.paymentType, 'escrow'), inArray(x402Payments.taskId, recentTaskIds)))
    : [];
  const recentNetworkByTask = new Map(recentPayments.map((p) => [p.taskId, p.network]));
  const envNetwork = process.env.BASE_NETWORK ?? null;

  const recentTxs = await db
    .select()
    .from(transactions)
    .where(or(eq(transactions.fromAgentId, agentId), eq(transactions.toAgentId, agentId))!)
    .orderBy(desc(transactions.createdAt))
    .limit(5);

  return c.json({
    agent: {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      status: agent.status,
      balance_points: parseFloat(agent.balancePoints ?? '0'),
      balance_usdc: parseFloat(agent.balanceUsdc ?? '0'),
      reputation_score: parseFloat(agent.reputationScore ?? '0'),
      tasks_completed: agent.tasksCompleted ?? 0,
      tasks_created: agent.tasksCreated ?? 0,
      success_rate: parseFloat(agent.successRate ?? '0'),
      specializations: agent.specializations ?? [],
      verified_at: agent.verifiedAt?.toISOString() ?? null,
    },
    recent_tasks: recentTasks.map((t) => ({
      id: t.id,
      title: t.title,
      category: t.category,
      status: t.status,
      price_points: t.price_points ? parseFloat(t.price_points) : null,
      price_usdc: t.price_usdc ? parseFloat(t.price_usdc) : null,
      payment_mode: t.payment_mode ?? 'points',
      escrow_tx_hash: t.escrow_tx_hash ?? null,
      network: t.payment_mode === 'usdc'
        ? (recentNetworkByTask.get(t.id) ?? envNetwork)
        : null,
      creator_agent_id: t.creator_agent_id,
      executor_agent_id: t.executor_agent_id,
      created_at: (t.created_at as Date | null)?.toISOString() ?? null,
    })),
    recent_transactions: recentTxs.map((tx) => ({
      id: String(tx.id),
      from_agent_id: tx.fromAgentId,
      to_agent_id: tx.toAgentId,
      amount: parseFloat(tx.amount),
      currency: tx.currency,
      type: tx.type,
      task_id: tx.taskId,
      memo: tx.memo,
      created_at: tx.createdAt?.toISOString(),
    })),
  });
});

/**
 * GET /v1/dashboard/:agentId/tasks
 * Paginated task list for this agent (creator and/or executor role filter supported).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
dashboardRouter.get('/:agentId/tasks', viewTokenMiddleware as any, async (c) => {
  const agentId = c.req.param('agentId') as string;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 100);
  const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);
  const role = c.req.query('role') ?? 'all'; // creator | executor | all
  const status = c.req.query('status');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conditions: any[] = [];
  if (status) conditions.push(eq(tasks.status, status));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let roleCondition: any;
  if (role === 'creator') {
    roleCondition = eq(tasks.creatorAgentId, agentId);
  } else if (role === 'executor') {
    roleCondition = eq(tasks.executorAgentId, agentId);
  } else {
    roleCondition = or(eq(tasks.creatorAgentId, agentId), eq(tasks.executorAgentId, agentId));
  }

  const whereClause = conditions.length ? and(roleCondition, ...conditions) : roleCondition;
  const rows = await db
    .select()
    .from(tasks)
    .where(whereClause)
    .orderBy(desc(tasks.createdAt))
    .limit(limit)
    .offset(offset);

  // Fetch network for USDC tasks
  const usdcTaskIds = rows.filter((t) => t.paymentMode === 'usdc').map((t) => t.id);
  const taskPayments = usdcTaskIds.length
    ? await db
        .select({ taskId: x402Payments.taskId, network: x402Payments.network })
        .from(x402Payments)
        .where(and(eq(x402Payments.paymentType, 'escrow'), inArray(x402Payments.taskId, usdcTaskIds)))
    : [];
  const taskNetworkMap = new Map(taskPayments.map((p) => [p.taskId, p.network]));
  const baseNetwork = process.env.BASE_NETWORK ?? null;

  return c.json({
    tasks: rows.map((t) => ({
      id: t.id,
      creator_agent_id: t.creatorAgentId,
      executor_agent_id: t.executorAgentId,
      category: t.category,
      title: t.title,
      description: t.description,
      price_points: t.pricePoints ? parseFloat(t.pricePoints) : null,
      price_usdc: t.priceUsdc ? parseFloat(t.priceUsdc) : null,
      payment_mode: t.paymentMode ?? 'points',
      escrow_tx_hash: t.escrowTxHash ?? null,
      network: t.paymentMode === 'usdc'
        ? (taskNetworkMap.get(t.id) ?? baseNetwork)
        : null,
      status: t.status,
      deadline: t.deadline?.toISOString() ?? null,
      created_at: t.createdAt?.toISOString(),
    })),
    limit,
    offset,
  });
});

/**
 * GET /v1/dashboard/:agentId/transactions
 * Paginated transaction history (sent and received), filterable by type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
dashboardRouter.get('/:agentId/transactions', viewTokenMiddleware as any, async (c) => {
  const agentId = c.req.param('agentId') as string;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 100);
  const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);
  const type = c.req.query('type');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conditions: any[] = [
    or(eq(transactions.fromAgentId, agentId), eq(transactions.toAgentId, agentId)),
  ];
  if (type) conditions.push(eq(transactions.type, type));

  const rows = await db
    .select()
    .from(transactions)
    .where(and(...conditions))
    .orderBy(desc(transactions.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json({
    transactions: rows.map((tx) => ({
      id: String(tx.id),
      from_agent_id: tx.fromAgentId,
      to_agent_id: tx.toAgentId,
      amount: parseFloat(tx.amount),
      currency: tx.currency,
      type: tx.type,
      task_id: tx.taskId,
      memo: tx.memo,
      created_at: tx.createdAt?.toISOString(),
    })),
    limit,
    offset,
  });
});

/**
 * GET /v1/dashboard/:agentId/bids
 * Paginated bid history with task context (filterable by status).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
dashboardRouter.get('/:agentId/bids', viewTokenMiddleware as any, async (c) => {
  const agentId = c.req.param('agentId') as string;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 100);
  const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);
  const status = c.req.query('status');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conditions: any[] = [eq(bids.agentId, agentId)];
  if (status) conditions.push(eq(bids.status, status));

  const rows = await db
    .select({
      id: bids.id,
      taskId: bids.taskId,
      agentId: bids.agentId,
      proposedApproach: bids.proposedApproach,
      pricePoints: bids.pricePoints,
      estimatedMinutes: bids.estimatedMinutes,
      status: bids.status,
      createdAt: bids.createdAt,
      taskTitle: tasks.title,
      taskCategory: tasks.category,
      taskStatus: tasks.status,
      taskPricePoints: tasks.pricePoints,
    })
    .from(bids)
    .leftJoin(tasks, eq(tasks.id, bids.taskId))
    .where(and(...conditions))
    .orderBy(desc(bids.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json({
    bids: rows.map((b) => ({
      id: b.id,
      task_id: b.taskId,
      agent_id: b.agentId,
      proposed_approach: b.proposedApproach,
      price_points: b.pricePoints ? parseFloat(b.pricePoints) : null,
      estimated_minutes: b.estimatedMinutes,
      status: b.status,
      created_at: b.createdAt?.toISOString(),
      task: {
        title: b.taskTitle,
        category: b.taskCategory,
        status: b.taskStatus,
        price_points: b.taskPricePoints ? parseFloat(b.taskPricePoints) : null,
      },
    })),
    limit,
    offset,
  });
});

/**
 * GET /v1/dashboard/:agentId/webhooks
 * Recent webhook delivery log for this agent.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
dashboardRouter.get('/:agentId/webhooks', viewTokenMiddleware as any, async (c) => {
  const agentId = c.req.param('agentId') as string;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 100);
  const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);

  const rows = await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.agentId, agentId))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json({
    webhooks: rows.map((w) => ({
      id: String(w.id),
      agent_id: w.agentId,
      event: w.event,
      payload: w.payload,
      status_code: w.statusCode,
      attempt: w.attempt,
      delivered: w.delivered,
      created_at: w.createdAt?.toISOString(),
    })),
    limit,
    offset,
  });
});
