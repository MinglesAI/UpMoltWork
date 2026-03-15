import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/pool.js';
import { agents } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { viewTokenMiddleware } from '../auth.js';

export const analyticsRouter = new Hono();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeFloat(val: unknown): number {
  const n = parseFloat(String(val ?? '0'));
  return isNaN(n) ? 0 : n;
}

function safeInt(val: unknown): number {
  const n = parseInt(String(val ?? '0'), 10);
  return isNaN(n) ? 0 : n;
}

function safeDivide(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// GET /:agentId/analytics — full overview
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
analyticsRouter.get('/:agentId/analytics', viewTokenMiddleware as any, async (c) => {
  const agentId = c.req.param('agentId') as string;

  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent) return c.json({ error: 'not_found', message: 'Agent not found' }, 404);

  // --- Bids stats ---
  const bidsResult = await db.execute(sql`
    SELECT
      COUNT(*)::int                                                       AS total,
      COUNT(*) FILTER (WHERE status = 'accepted')::int                   AS accepted,
      COUNT(*) FILTER (WHERE status = 'rejected')::int                   AS rejected,
      COUNT(*) FILTER (WHERE status = 'pending')::int                    AS pending,
      COUNT(*) FILTER (WHERE status = 'withdrawn')::int                  AS withdrawn,
      AVG(price_points::numeric)                                          AS avg_bid_price,
      AVG(price_points::numeric) FILTER (WHERE status = 'accepted')      AS avg_winning_bid_price
    FROM bids
    WHERE agent_id = ${agentId}
  `);
  const bRow = bidsResult.rows[0] as Record<string, unknown> ?? {};
  const bTotal = safeInt(bRow.total);
  const bAccepted = safeInt(bRow.accepted);

  // --- Earnings stats ---
  const earningsResult = await db.execute(sql`
    SELECT
      COALESCE(SUM(amount::numeric) FILTER (WHERE to_agent_id = ${agentId} AND currency = 'points'), 0)  AS total_points_earned,
      COALESCE(SUM(amount::numeric) FILTER (WHERE to_agent_id = ${agentId} AND currency = 'usdc'), 0)    AS total_usdc_earned,
      COALESCE(SUM(amount::numeric) FILTER (WHERE from_agent_id = ${agentId} AND currency = 'points'), 0) AS total_points_spent,
      COALESCE(COUNT(*) FILTER (WHERE to_agent_id = ${agentId} AND type = 'task_payment'), 0)::int       AS task_payments_count,
      COALESCE(MAX(amount::numeric) FILTER (WHERE to_agent_id = ${agentId} AND type = 'task_payment'), 0) AS best_payout,
      COALESCE(AVG(amount::numeric) FILTER (WHERE to_agent_id = ${agentId} AND type = 'task_payment'), 0) AS avg_task_payout,
      COALESCE(SUM(amount::numeric) FILTER (WHERE to_agent_id = ${agentId} AND type = 'validation_reward'), 0) AS validation_rewards
    FROM transactions
    WHERE to_agent_id = ${agentId} OR from_agent_id = ${agentId}
  `);
  const eRow = earningsResult.rows[0] as Record<string, unknown> ?? {};
  const totalPointsEarned = safeFloat(eRow.total_points_earned);
  const totalPointsSpent = safeFloat(eRow.total_points_spent);

  // --- Tasks stats ---
  const tasksResult = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE creator_agent_id = ${agentId})::int          AS created,
      COUNT(*) FILTER (WHERE executor_agent_id = ${agentId})::int         AS executed,
      COUNT(*) FILTER (WHERE executor_agent_id = ${agentId} AND status = 'completed')::int  AS completed,
      COUNT(*) FILTER (WHERE executor_agent_id = ${agentId} AND status = 'disputed')::int   AS failed_validation
    FROM tasks
    WHERE creator_agent_id = ${agentId} OR executor_agent_id = ${agentId}
  `);
  const tRow = tasksResult.rows[0] as Record<string, unknown> ?? {};
  const tExecuted = safeInt(tRow.executed);
  const tCompleted = safeInt(tRow.completed);

  // --- Gigs stats ---
  const gigsResult = await db.execute(sql`
    SELECT
      COUNT(DISTINCT g.id)::int                                                     AS total_gigs,
      COUNT(go.id)::int                                                             AS total_orders_received,
      COUNT(go.id) FILTER (WHERE go.status = 'completed')::int                    AS orders_completed,
      COUNT(go.id) FILTER (WHERE go.status = 'cancelled')::int                    AS orders_cancelled,
      COUNT(go.id) FILTER (WHERE go.status = 'disputed')::int                     AS orders_disputed,
      COALESCE(SUM(go.price_points::numeric) FILTER (WHERE go.status = 'completed'), 0) AS total_earned
    FROM gigs g
    LEFT JOIN gig_orders go ON go.gig_id = g.id AND go.seller_agent_id = ${agentId}
    WHERE g.creator_agent_id = ${agentId}
  `);
  const gRow = gigsResult.rows[0] as Record<string, unknown> ?? {};

  // Average rating from task_ratings
  const ratingResult = await db.execute(sql`
    SELECT COALESCE(AVG(rating::numeric), 0) AS avg_rating
    FROM task_ratings
    WHERE rated_agent_id = ${agentId}
  `);
  const ratingRow = ratingResult.rows[0] as Record<string, unknown> ?? {};

  return c.json({
    agent_id: agentId,
    period: 'all_time',
    bids: {
      total: bTotal,
      accepted: bAccepted,
      rejected: safeInt(bRow.rejected),
      pending: safeInt(bRow.pending),
      withdrawn: safeInt(bRow.withdrawn),
      win_rate: safeDivide(bAccepted, bTotal),
      avg_bid_price: safeFloat(bRow.avg_bid_price),
      avg_winning_bid_price: safeFloat(bRow.avg_winning_bid_price),
    },
    earnings: {
      total_points_earned: totalPointsEarned,
      total_usdc_earned: safeFloat(eRow.total_usdc_earned),
      total_points_spent: totalPointsSpent,
      net_points: totalPointsEarned - totalPointsSpent,
      avg_task_payout: safeFloat(eRow.avg_task_payout),
      best_payout: safeFloat(eRow.best_payout),
      validation_rewards: safeFloat(eRow.validation_rewards),
    },
    tasks: {
      created: safeInt(tRow.created),
      executed: tExecuted,
      completed: tCompleted,
      failed_validation: safeInt(tRow.failed_validation),
      success_rate: safeDivide(tCompleted, tExecuted),
    },
    gigs: {
      total_gigs: safeInt(gRow.total_gigs),
      total_orders_received: safeInt(gRow.total_orders_received),
      orders_completed: safeInt(gRow.orders_completed),
      orders_cancelled: safeInt(gRow.orders_cancelled),
      orders_disputed: safeInt(gRow.orders_disputed),
      avg_rating: Math.round(safeFloat(ratingRow.avg_rating) * 10) / 10,
      total_earned: safeFloat(gRow.total_earned),
    },
    reputation: {
      current: safeFloat(agent.reputationScore),
      change_30d: null, // requires reputation_snapshots table (not yet implemented)
      history: [],      // requires reputation_snapshots table
    },
  });
});

// ---------------------------------------------------------------------------
// GET /:agentId/analytics/earnings — earnings time series
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
analyticsRouter.get('/:agentId/analytics/earnings', viewTokenMiddleware as any, async (c) => {
  const agentId = c.req.param('agentId') as string;

  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent) return c.json({ error: 'not_found', message: 'Agent not found' }, 404);

  const periodParam = c.req.query('period') ?? '30d';
  const groupBy = c.req.query('group_by') ?? 'day';

  // Validate params
  const validPeriods = ['7d', '30d', '90d', 'all'] as const;
  const validGroupBy = ['day', 'week', 'month'] as const;
  if (!validPeriods.includes(periodParam as typeof validPeriods[number])) {
    return c.json({ error: 'invalid_param', message: 'period must be 7d, 30d, 90d, or all' }, 400);
  }
  if (!validGroupBy.includes(groupBy as typeof validGroupBy[number])) {
    return c.json({ error: 'invalid_param', message: 'group_by must be day, week, or month' }, 400);
  }

  // Build interval clause
  const intervalMap: Record<string, string> = {
    '7d': '7 days',
    '30d': '30 days',
    '90d': '90 days',
  };
  const intervalClause =
    periodParam === 'all'
      ? sql`TRUE`
      : sql`created_at >= NOW() - INTERVAL ${sql.raw(`'${intervalMap[periodParam]}'`)}`;

  // Build date trunc
  const truncPart = sql.raw(`'${groupBy}'`);

  const seriesResult = await db.execute(sql`
    SELECT
      DATE_TRUNC(${truncPart}, created_at)::date                                            AS date,
      COALESCE(SUM(amount::numeric) FILTER (WHERE to_agent_id = ${agentId} AND currency = 'points'), 0)   AS earned_points,
      COALESCE(SUM(amount::numeric) FILTER (WHERE from_agent_id = ${agentId} AND currency = 'points'), 0) AS spent_points,
      COALESCE(SUM(amount::numeric) FILTER (WHERE to_agent_id = ${agentId} AND currency = 'usdc'), 0)     AS earned_usdc,
      COUNT(*)::int                                                                          AS transaction_count
    FROM transactions
    WHERE (to_agent_id = ${agentId} OR from_agent_id = ${agentId})
      AND ${intervalClause}
    GROUP BY 1
    ORDER BY 1
  `);

  type SeriesRow = {
    date: string | Date;
    earned_points: unknown;
    spent_points: unknown;
    earned_usdc: unknown;
    transaction_count: unknown;
  };

  const series = (seriesResult.rows as SeriesRow[]).map((r) => {
    const earned = safeFloat(r.earned_points);
    const spent = safeFloat(r.spent_points);
    const dateStr = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10);
    return {
      date: dateStr,
      earned_points: earned,
      spent_points: spent,
      net_points: earned - spent,
      earned_usdc: safeFloat(r.earned_usdc),
      transaction_count: safeInt(r.transaction_count),
    };
  });

  const totalsResult = await db.execute(sql`
    SELECT
      COALESCE(SUM(amount::numeric) FILTER (WHERE to_agent_id = ${agentId} AND currency = 'points'), 0)   AS earned_points,
      COALESCE(SUM(amount::numeric) FILTER (WHERE from_agent_id = ${agentId} AND currency = 'points'), 0) AS spent_points,
      COALESCE(SUM(amount::numeric) FILTER (WHERE to_agent_id = ${agentId} AND currency = 'usdc'), 0)     AS earned_usdc
    FROM transactions
    WHERE (to_agent_id = ${agentId} OR from_agent_id = ${agentId})
      AND ${intervalClause}
  `);
  const totRow = totalsResult.rows[0] as Record<string, unknown> ?? {};
  const totEarned = safeFloat(totRow.earned_points);
  const totSpent = safeFloat(totRow.spent_points);

  return c.json({
    period: periodParam,
    group_by: groupBy,
    series,
    totals: {
      earned_points: totEarned,
      spent_points: totSpent,
      net_points: totEarned - totSpent,
      earned_usdc: safeFloat(totRow.earned_usdc),
    },
  });
});

// ---------------------------------------------------------------------------
// GET /:agentId/analytics/bids — win rate by category and price range
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
analyticsRouter.get('/:agentId/analytics/bids', viewTokenMiddleware as any, async (c) => {
  const agentId = c.req.param('agentId') as string;

  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent) return c.json({ error: 'not_found', message: 'Agent not found' }, 404);

  // By category — join with tasks to get category
  const byCategoryResult = await db.execute(sql`
    SELECT
      t.category,
      COUNT(b.id)::int                                             AS total,
      COUNT(b.id) FILTER (WHERE b.status = 'accepted')::int      AS won
    FROM bids b
    JOIN tasks t ON t.id = b.task_id
    WHERE b.agent_id = ${agentId}
    GROUP BY t.category
    ORDER BY total DESC
  `);

  type CategoryRow = { category: string; total: unknown; won: unknown };
  const byCategory = (byCategoryResult.rows as CategoryRow[]).map((r) => {
    const total = safeInt(r.total);
    const won = safeInt(r.won);
    return {
      category: r.category,
      total,
      won,
      win_rate: safeDivide(won, total),
    };
  });

  // By price range — using price_points on the bid itself
  const byPriceResult = await db.execute(sql`
    SELECT
      CASE
        WHEN price_points::numeric <= 50                             THEN '0-50'
        WHEN price_points::numeric <= 100                           THEN '51-100'
        WHEN price_points::numeric <= 200                           THEN '101-200'
        ELSE '200+'
      END                                                           AS range,
      COUNT(*)::int                                                 AS total,
      COUNT(*) FILTER (WHERE status = 'accepted')::int             AS won
    FROM bids
    WHERE agent_id = ${agentId}
      AND price_points IS NOT NULL
    GROUP BY 1
    ORDER BY MIN(price_points::numeric)
  `);

  const rangeOrder = ['0-50', '51-100', '101-200', '200+'];
  type PriceRow = { range: string; total: unknown; won: unknown };
  const byPriceRaw = (byPriceResult.rows as PriceRow[]).map((r) => ({
    range: r.range,
    total: safeInt(r.total),
    won: safeInt(r.won),
  }));
  // Sort by canonical order
  const byPriceMap = new Map<string, { total: number; won: number }>();
  for (const r of byPriceRaw) byPriceMap.set(r.range, r);
  const byPriceRange = rangeOrder
    .filter((rng) => byPriceMap.has(rng))
    .map((rng) => {
      const r = byPriceMap.get(rng)!;
      return { range: rng, total: r.total, won: r.won, win_rate: safeDivide(r.won, r.total) };
    });

  // Trend: win rate in last 30d vs prior 30d
  const trendResult = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE b.created_at >= NOW() - INTERVAL '30 days')::int               AS recent_total,
      COUNT(*) FILTER (WHERE b.created_at >= NOW() - INTERVAL '30 days' AND b.status = 'accepted')::int AS recent_won,
      COUNT(*) FILTER (WHERE b.created_at >= NOW() - INTERVAL '60 days'
                          AND b.created_at <  NOW() - INTERVAL '30 days')::int              AS prev_total,
      COUNT(*) FILTER (WHERE b.created_at >= NOW() - INTERVAL '60 days'
                          AND b.created_at <  NOW() - INTERVAL '30 days'
                          AND b.status = 'accepted')::int                                   AS prev_won
    FROM bids b
    WHERE b.agent_id = ${agentId}
  `);
  const tRow = trendResult.rows[0] as Record<string, unknown> ?? {};
  const recentTotal = safeInt(tRow.recent_total);
  const recentWon = safeInt(tRow.recent_won);
  const prevTotal = safeInt(tRow.prev_total);
  const prevWon = safeInt(tRow.prev_won);
  const recentWinRate = safeDivide(recentWon, recentTotal);
  const prevWinRate = safeDivide(prevWon, prevTotal);

  return c.json({
    by_category: byCategory,
    by_price_range: byPriceRange,
    trend_30d: {
      win_rate: recentWinRate,
      vs_prev_30d: Math.round((recentWinRate - prevWinRate) * 1000) / 1000,
    },
  });
});
