import { Hono } from 'hono';
import { eq, desc, sql } from 'drizzle-orm';
import { db } from '../db/pool.js';
import { agents, tasks, transactions, type AgentRow } from '../db/schema/index.js';
import { authMiddleware } from '../auth.js';
import { p2pTransfer } from '../lib/transfer.js';
import { idempotencyMiddleware } from '../middleware/idempotency.js';
import { rateLimitMiddleware, rateLimitTransfer } from '../middleware/rateLimit.js';

type AppVariables = { agent: AgentRow; agentId: string };

export const pointsRouter = new Hono<{ Variables: AppVariables }>();

/**
 * GET /v1/points/balance
 * Current points and USDC balance (auth required).
 */
pointsRouter.get('/balance', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  return c.json({
    agent_id: agent.id,
    balance_points: parseFloat(agent.balancePoints ?? '0'),
    balance_usdc: parseFloat(agent.balanceUsdc ?? '0'),
  });
});

/**
 * GET /v1/points/history
 * Transaction history (auth required, paginated, filterable by type).
 */
pointsRouter.get('/history', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 100);
  const type = c.req.query('type');

  const rows = await db
    .select()
    .from(transactions)
    .where(eq(transactions.toAgentId, agent.id))
    .orderBy(desc(transactions.createdAt))
    .limit(limit);

  const filtered = type ? rows.filter((r) => r.type === type) : rows;

  return c.json(
    filtered.map((r) => ({
      id: r.id,
      from_agent_id: r.fromAgentId,
      to_agent_id: r.toAgentId,
      amount: parseFloat(r.amount),
      currency: r.currency,
      type: r.type,
      task_id: r.taskId,
      memo: r.memo,
      created_at: r.createdAt?.toISOString(),
    })),
  );
});

/**
 * POST /v1/points/transfer
 * P2P transfer between verified agents (idempotent via Idempotency-Key header).
 * No platform fee on P2P transfers.
 */
pointsRouter.post('/transfer', authMiddleware, rateLimitTransfer, idempotencyMiddleware, async (c) => {
  const agent = c.get('agent');
  if (agent.status !== 'verified') {
    return c.json({ error: 'forbidden', message: 'Verified agents only' }, 403);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Invalid JSON' }, 400);
  }

  const b = body as Record<string, unknown>;
  const toAgentId = typeof b.to_agent_id === 'string' ? b.to_agent_id.trim() : '';
  const amount =
    typeof b.amount === 'number'
      ? b.amount
      : typeof b.amount === 'string'
        ? parseFloat(b.amount)
        : 0;
  const memo = typeof b.memo === 'string' ? b.memo : null;

  if (!toAgentId || amount < 1) {
    return c.json(
      { error: 'invalid_request', message: 'to_agent_id and amount (>=1) required' },
      400,
    );
  }

  const [recipient] = await db.select().from(agents).where(eq(agents.id, toAgentId)).limit(1);
  if (!recipient) return c.json({ error: 'not_found', message: 'Recipient agent not found' }, 404);
  if (recipient.status !== 'verified') {
    return c.json({ error: 'forbidden', message: 'Recipient must be verified' }, 403);
  }

  try {
    await p2pTransfer({
      fromAgentId: agent.id,
      toAgentId,
      amount,
      memo: memo ?? undefined,
    });
  } catch (err) {
    const e = err as Error;
    if (e.message.includes('Insufficient balance')) {
      return c.json({ error: 'insufficient_balance', message: e.message }, 402);
    }
    throw err;
  }

  const [updated] = await db
    .select({ balance: agents.balancePoints })
    .from(agents)
    .where(eq(agents.id, agent.id))
    .limit(1);

  return c.json(
    {
      message: 'Transfer complete',
      amount,
      to_agent_id: toAgentId,
      new_balance: parseFloat(updated!.balance ?? '0'),
    },
    200,
  );
});

/**
 * GET /v1/points/economy
 * Platform economy stats (public).
 */
pointsRouter.get('/economy', async (c) => {
  const [agentsCount] = await db
    .select({ n: sql<number>`count(*)` })
    .from(agents)
    .limit(1);
  const [verifiedCount] = await db
    .select({ n: sql<number>`count(*)` })
    .from(agents)
    .where(eq(agents.status, 'verified'))
    .limit(1);
  const [tasksCount] = await db
    .select({ n: sql<number>`count(*)` })
    .from(tasks)
    .limit(1);
  const [completedCount] = await db
    .select({ n: sql<number>`count(*)` })
    .from(tasks)
    .where(eq(tasks.status, 'completed'))
    .limit(1);
  const [supply] = await db
    .select({ total: sql<string>`coalesce(sum(balance_points), 0)` })
    .from(agents)
    .limit(1);
  const [txCount] = await db
    .select({ n: sql<number>`count(*)` })
    .from(transactions)
    .limit(1);

  return c.json({
    total_agents: Number((agentsCount as { n: number })?.n ?? 0),
    verified_agents: Number((verifiedCount as { n: number })?.n ?? 0),
    total_tasks: Number((tasksCount as { n: number })?.n ?? 0),
    tasks_completed: Number((completedCount as { n: number })?.n ?? 0),
    total_points_supply: parseFloat(String((supply as { total: string })?.total ?? '0')),
    total_transactions: Number((txCount as { n: number })?.n ?? 0),
  });
});
