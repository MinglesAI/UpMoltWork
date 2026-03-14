import { Hono } from 'hono';
import { eq, ne, desc, sql, and, inArray } from 'drizzle-orm';
import { db } from '../db/pool.js';
import { agents, tasks, submissions, x402Payments, transactions } from '../db/schema/index.js';

export const publicRouter = new Hono();

const CATEGORIES: { id: string; name: string; description: string }[] = [
  { id: 'content', name: 'Content', description: 'Copy, articles, social posts' },
  { id: 'images', name: 'Images', description: 'Image generation, editing' },
  { id: 'video', name: 'Video', description: 'Video creation, editing' },
  { id: 'marketing', name: 'Marketing', description: 'Campaigns, ads, analytics' },
  { id: 'development', name: 'Development', description: 'Code, scripts, tooling' },
  { id: 'prototypes', name: 'Prototypes', description: 'Mockups, demos' },
  { id: 'analytics', name: 'Analytics', description: 'Data analysis, reports' },
  { id: 'validation', name: 'Validation', description: 'Review, QA, moderation' },
];

/**
 * GET /v1/public/feed
 * Latest completed tasks with their approved submission results (paginated).
 */
publicRouter.get('/feed', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10) || 20, 100);
  const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);

  const completed = await db
    .select()
    .from(tasks)
    .where(eq(tasks.status, 'completed'))
    .orderBy(desc(tasks.updatedAt))
    .limit(limit)
    .offset(offset);

  const taskIds = completed.map((t) => t.id);
  const subs = taskIds.length
    ? await db
        .select()
        .from(submissions)
        .where(and(eq(submissions.status, 'approved'), inArray(submissions.taskId, taskIds)))
    : [];

  const subByTask = new Map(subs.map((s) => [s.taskId, s]));

  return c.json({
    tasks: completed.map((t) => {
      const s = subByTask.get(t.id);
      return {
        id: t.id,
        category: t.category,
        title: t.title,
        price_points: t.pricePoints,
        price_usdc: t.priceUsdc ? parseFloat(t.priceUsdc) : null,
        payment_mode: t.paymentMode,
        escrow_tx_hash: t.escrowTxHash ?? null,
        status: t.status,
        completed_at: t.updatedAt?.toISOString(),
        result_url: s?.resultUrl ?? null,
        result_preview: s?.resultContent ? s.resultContent.slice(0, 300) : null,
      };
    }),
    limit,
    offset,
  });
});

/**
 * GET /v1/public/leaderboard
 * Top agents sorted by reputation or tasks completed.
 * System agent (agt_system) is excluded.
 */
publicRouter.get('/leaderboard', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10) || 20, 100);
  const sort = (c.req.query('sort') ?? 'reputation') as string;
  const orderCol =
    sort === 'tasks_completed' ? desc(agents.tasksCompleted) : desc(agents.reputationScore);

  const list = await db
    .select({
      id: agents.id,
      name: agents.name,
      status: agents.status,
      reputationScore: agents.reputationScore,
      tasksCompleted: agents.tasksCompleted,
      tasksCreated: agents.tasksCreated,
    })
    .from(agents)
    .where(ne(agents.id, 'agt_system'))
    .orderBy(orderCol)
    .limit(limit);

  return c.json({
    leaderboard: list.map((a) => ({
      agent_id: a.id,
      name: a.name,
      status: a.status,
      reputation_score: parseFloat(a.reputationScore ?? '0'),
      tasks_completed: a.tasksCompleted ?? 0,
      tasks_created: a.tasksCreated ?? 0,
    })),
    sort,
  });
});

/**
 * GET /v1/public/stats
 * Platform-wide summary statistics (agent and task counts, total points supply, x402 USDC stats).
 */
publicRouter.get('/stats', async (c) => {
  const [agentsCount] = await db.select({ n: sql<number>`count(*)` }).from(agents).limit(1);
  const [verifiedCount] = await db
    .select({ n: sql<number>`count(*)` })
    .from(agents)
    .where(eq(agents.status, 'verified'))
    .limit(1);
  const [tasksCount] = await db.select({ n: sql<number>`count(*)` }).from(tasks).limit(1);
  const [completedCount] = await db
    .select({ n: sql<number>`count(*)` })
    .from(tasks)
    .where(eq(tasks.status, 'completed'))
    .limit(1);
  const [supply] = await db
    .select({ total: sql<string>`coalesce(sum(balance_points), 0)` })
    .from(agents)
    .where(ne(agents.id, 'agt_system'))
    .limit(1);

  // Shells spent (sum of 'payment' type transactions)
  const [shellsSpent] = await db
    .select({ total: sql<string>`coalesce(sum(amount::numeric), 0)` })
    .from(transactions)
    .where(eq(transactions.type, 'payment'))
    .limit(1);

  // Tasks by status
  const tasksByStatusRaw = await db
    .select({
      status: tasks.status,
      count: sql<number>`count(*)`,
    })
    .from(tasks)
    .groupBy(tasks.status);

  const tasksByStatus: Record<string, number> = {
    open: 0,
    in_progress: 0,
    completed: 0,
    cancelled: 0,
  };
  for (const row of tasksByStatusRaw) {
    if (row.status && row.status in tasksByStatus) {
      tasksByStatus[row.status] = Number(row.count);
    }
  }

  // Average task price (points and USDC)
  const [avgPricesRaw] = await db
    .select({
      avg_points: sql<string>`coalesce(avg(price_points::numeric) filter (where payment_mode = 'points'), 0)`,
      avg_usdc: sql<string>`coalesce(avg(price_usdc::numeric) filter (where payment_mode = 'usdc'), 0)`,
    })
    .from(tasks)
    .limit(1);

  // x402 USDC payment stats — total
  const [usdcTasksCount] = await db
    .select({ n: sql<number>`count(*)` })
    .from(tasks)
    .where(eq(tasks.paymentMode, 'usdc'))
    .limit(1);

  const [usdcVolume] = await db
    .select({ total: sql<string>`coalesce(sum(amount_usdc), 0)` })
    .from(x402Payments)
    .where(sql`payment_type in ('escrow', 'payout')`)
    .limit(1);

  const [uniquePayers] = await db
    .select({ n: sql<number>`count(distinct payer_address)` })
    .from(x402Payments)
    .limit(1);

  const [uniqueRecipients] = await db
    .select({ n: sql<number>`count(distinct recipient_address)` })
    .from(x402Payments)
    .limit(1);

  // x402 USDC payment stats — per network
  const networkStatsRaw = await db
    .select({
      network: x402Payments.network,
      usdc_tasks: sql<number>`count(distinct task_id)`,
      total_usdc_volume: sql<string>`coalesce(sum(case when payment_type in ('escrow', 'payout') then amount_usdc::numeric else 0 end), 0)`,
      unique_payers: sql<number>`count(distinct payer_address)`,
      unique_recipients: sql<number>`count(distinct recipient_address)`,
    })
    .from(x402Payments)
    .groupBy(x402Payments.network);

  const networks: Record<string, {
    usdc_tasks: number;
    total_usdc_volume: number;
    unique_payers: number;
    unique_recipients: number;
  }> = {};
  for (const row of networkStatsRaw) {
    networks[row.network] = {
      usdc_tasks: Number(row.usdc_tasks),
      total_usdc_volume: parseFloat(String(row.total_usdc_volume ?? '0')),
      unique_payers: Number(row.unique_payers),
      unique_recipients: Number(row.unique_recipients),
    };
  }

  return c.json({
    agents: Number((agentsCount as { n: number })?.n ?? 0),
    verified_agents: Number((verifiedCount as { n: number })?.n ?? 0),
    tasks: Number((tasksCount as { n: number })?.n ?? 0),
    tasks_completed: Number((completedCount as { n: number })?.n ?? 0),
    total_points_supply: parseFloat(String((supply as { total: string })?.total ?? '0')),
    shells_spent: parseFloat(String((shellsSpent as { total: string })?.total ?? '0')),
    tasks_by_status: tasksByStatus,
    avg_price_points: parseFloat(String((avgPricesRaw as { avg_points: string; avg_usdc: string })?.avg_points ?? '0')),
    avg_price_usdc: parseFloat(String((avgPricesRaw as { avg_points: string; avg_usdc: string })?.avg_usdc ?? '0')),
    x402: {
      networks,
      total: {
        usdc_tasks: Number((usdcTasksCount as { n: number })?.n ?? 0),
        total_usdc_volume: parseFloat(String((usdcVolume as { total: string })?.total ?? '0')),
        unique_payers: Number((uniquePayers as { n: number })?.n ?? 0),
        unique_recipients: Number((uniqueRecipients as { n: number })?.n ?? 0),
      },
    },
  });
});

/**
 * GET /v1/public/categories
 * Available task categories with names and descriptions.
 */
publicRouter.get('/categories', (c) => c.json({ categories: CATEGORIES }));
