import { Hono } from 'hono';
import { eq, desc, or } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { db } from '../db/pool.js';
import { agents, tasks, type AgentRow } from '../db/schema/index.js';
import { authMiddleware } from '../auth.js';
import {
  generateAgentId,
  generateApiKey,
  generateWebhookSecret,
} from '../lib/ids.js';
import { systemCredit } from '../lib/transfer.js';
import { rateLimitMiddleware } from '../middleware/rateLimit.js';

type AppVariables = { agent: AgentRow; agentId: string };

const VERIFIED_STARTER_BONUS = 100;

export const agentsRouter = new Hono<{ Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// Agent registry
// ---------------------------------------------------------------------------

/**
 * POST /v1/agents/register
 * Register a new agent. Returns api_key once.
 * Auto-verifies when TWITTER_API_BEARER_TOKEN is not set (dev/stub mode).
 */
agentsRouter.post('/register', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400);
  }

  const b = body as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const ownerTwitter =
    typeof b.owner_twitter === 'string' ? b.owner_twitter.trim().replace(/^@/, '') : '';

  if (!name || name.length > 100) {
    return c.json({ error: 'invalid_request', message: 'name is required (max 100 chars)' }, 400);
  }
  if (!ownerTwitter || ownerTwitter.length > 50) {
    return c.json(
      { error: 'invalid_request', message: 'owner_twitter is required (max 50 chars)' },
      400,
    );
  }

  const description =
    typeof b.description === 'string' ? b.description.slice(0, 2000) : null;
  const specializations = Array.isArray(b.specializations)
    ? (b.specializations as string[])
        .filter((s): s is string => typeof s === 'string')
        .slice(0, 20)
    : [];
  const webhookUrl =
    typeof b.webhook_url === 'string' ? b.webhook_url.trim() || null : null;
  const a2aCardUrl =
    typeof b.a2a_agent_card_url === 'string' ? b.a2a_agent_card_url.trim() || null : null;

  const agentId = generateAgentId();
  const apiKey = generateApiKey(agentId);
  const webhookSecret = generateWebhookSecret();
  const apiKeyHash = await bcrypt.hash(apiKey, 10);

  // Auto-verify when no Twitter API is configured (stub / dev mode)
  const autoVerify = !process.env.TWITTER_API_BEARER_TOKEN;
  const now = new Date();

  try {
    await db.insert(agents).values({
      id: agentId,
      name,
      description: description ?? null,
      ownerTwitter,
      status: autoVerify ? 'verified' : 'unverified',
      balancePoints: '10',
      verifiedAt: autoVerify ? now : null,
      specializations: specializations.length ? specializations : [],
      webhookUrl,
      webhookSecret,
      a2aCardUrl,
      apiKeyHash,
    });
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === '23505') {
      return c.json({ error: 'conflict', message: 'owner_twitter already registered' }, 409);
    }
    throw err;
  }

  if (autoVerify) {
    await systemCredit({
      toAgentId: agentId,
      amount: VERIFIED_STARTER_BONUS,
      type: 'starter_bonus',
      memo: 'Auto-verification bonus (Twitter API not configured)',
    });
    return c.json(
      {
        agent_id: agentId,
        api_key: apiKey,
        status: 'verified',
        balance: 10 + VERIFIED_STARTER_BONUS,
        message: 'Registered and auto-verified. Full access granted.',
      },
      201,
    );
  }

  return c.json(
    {
      agent_id: agentId,
      api_key: apiKey,
      status: 'unverified',
      balance: 10,
      message: 'Registered. Complete verification to unlock full access and receive starter balance.',
    },
    201,
  );
});

/**
 * GET /v1/agents/me
 * Current agent profile (auth required).
 */
agentsRouter.get('/me', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  return c.json({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    owner_twitter: agent.ownerTwitter,
    status: agent.status,
    balance_points: parseFloat(agent.balancePoints ?? '0'),
    balance_usdc: parseFloat(agent.balanceUsdc ?? '0'),
    reputation_score: parseFloat(agent.reputationScore ?? '0'),
    tasks_completed: agent.tasksCompleted ?? 0,
    tasks_created: agent.tasksCreated ?? 0,
    success_rate: parseFloat(agent.successRate ?? '0'),
    evm_address: agent.evmAddress ?? null,
    specializations: agent.specializations ?? [],
    webhook_url: agent.webhookUrl,
    webhook_secret: agent.webhookSecret ? `${agent.webhookSecret.slice(0, 8)}...` : null,
    a2a_card_url: agent.a2aCardUrl,
    verified_at: agent.verifiedAt?.toISOString() ?? null,
    created_at: agent.createdAt?.toISOString(),
    updated_at: agent.updatedAt?.toISOString(),
  });
});

/**
 * PATCH /v1/agents/me
 * Update agent profile (auth required).
 */
agentsRouter.patch('/me', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400);
  }
  const b = body as Record<string, unknown>;
  const updates: Record<string, unknown> = {};
  if (typeof b.name === 'string' && b.name.trim()) updates.name = b.name.trim().slice(0, 100);
  if (typeof b.description === 'string')
    updates.description = b.description.slice(0, 2000) || null;
  if (Array.isArray(b.specializations)) {
    updates.specializations = (b.specializations as string[])
      .filter((s): s is string => typeof s === 'string')
      .slice(0, 20);
  }
  if (typeof b.webhook_url === 'string') updates.webhookUrl = b.webhook_url.trim() || null;
  if (typeof b.a2a_agent_card_url === 'string')
    updates.a2aCardUrl = b.a2a_agent_card_url.trim() || null;

  // x402: EVM wallet address for USDC payouts
  if (typeof b.evm_address === 'string') {
    const addr = b.evm_address.trim();
    if (addr && !/^0x[a-fA-F0-9]{40}$/.test(addr)) {
      return c.json(
        { error: 'invalid_request', message: 'evm_address must be a valid EVM address (0x + 40 hex chars)' },
        400,
      );
    }
    updates.evmAddress = addr || null;
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'invalid_request', message: 'No valid fields to update' }, 400);
  }

  await db
    .update(agents)
    .set({ ...updates, updatedAt: new Date() } as Record<string, unknown>)
    .where(eq(agents.id, agent.id));

  const [updated] = await db.select().from(agents).where(eq(agents.id, agent.id)).limit(1);
  return c.json({
    id: updated!.id,
    name: updated!.name,
    description: updated!.description,
    owner_twitter: updated!.ownerTwitter,
    status: updated!.status,
    balance_points: parseFloat(updated!.balancePoints ?? '0'),
    evm_address: updated!.evmAddress ?? null,
    specializations: updated!.specializations ?? [],
    webhook_url: updated!.webhookUrl,
    a2a_card_url: updated!.a2aCardUrl,
    updated_at: updated!.updatedAt?.toISOString(),
  });
});

/**
 * POST /v1/agents/me/rotate-key
 * Rotate API key (auth required). Old key is invalidated immediately.
 */
agentsRouter.post('/me/rotate-key', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  const newKey = generateApiKey(agent.id);
  const hash = await bcrypt.hash(newKey, 10);
  await db
    .update(agents)
    .set({ apiKeyHash: hash, updatedAt: new Date() })
    .where(eq(agents.id, agent.id));
  return c.json({
    api_key: newKey,
    message: 'API key rotated. Old key is now invalid.',
  });
});

/**
 * POST /v1/agents/me/view-token
 * Generate a read-only view token (JWT) for the agent dashboard.
 */
agentsRouter.post('/me/view-token', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent') as AgentRow;
  const { generateViewToken } = await import('../auth.js');
  try {
    const token = await generateViewToken(agent.id);
    const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
    return c.json({
      token,
      agent_id: agent.id,
      expires_at: new Date(exp * 1000).toISOString(),
      dashboard_url: `/dashboard/${agent.id}?token=${token}`,
    });
  } catch {
    return c.json({ error: 'server_error', message: 'JWT_SECRET not configured' }, 500);
  }
});

// ---------------------------------------------------------------------------
// Public agent list
// ---------------------------------------------------------------------------

/**
 * GET /v1/agents
 * List verified agents (public).
 */
agentsRouter.get('/', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 100);
  const list = await db
    .select({
      id: agents.id,
      name: agents.name,
      description: agents.description,
      status: agents.status,
      reputation_score: agents.reputationScore,
      tasks_completed: agents.tasksCompleted,
      specializations: agents.specializations,
    })
    .from(agents)
    .where(eq(agents.status, 'verified'))
    .limit(limit);
  return c.json({ agents: list });
});

/**
 * GET /v1/agents/:id
 * Public agent profile.
 */
agentsRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  const [a] = await db
    .select({
      id: agents.id,
      name: agents.name,
      description: agents.description,
      status: agents.status,
      reputation_score: agents.reputationScore,
      tasks_completed: agents.tasksCompleted,
      tasks_created: agents.tasksCreated,
      success_rate: agents.successRate,
      specializations: agents.specializations,
      verified_at: agents.verifiedAt,
    })
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1);

  if (!a) return c.json({ error: 'not_found', message: 'Agent not found' }, 404);

  return c.json({
    id: a.id,
    name: a.name,
    description: a.description,
    status: a.status,
    reputation_score: parseFloat(String(a.reputation_score ?? '0')),
    tasks_completed: a.tasks_completed ?? 0,
    tasks_created: a.tasks_created ?? 0,
    success_rate: parseFloat(String(a.success_rate ?? '0')),
    specializations: a.specializations ?? [],
    verified_at: (a.verified_at as Date | null)?.toISOString() ?? null,
  });
});

/**
 * GET /v1/agents/:id/reputation
 * Public reputation breakdown for an agent.
 */
agentsRouter.get('/:id/reputation', async (c) => {
  const id = c.req.param('id');
  const [a] = await db
    .select({
      tasks_completed: agents.tasksCompleted,
      tasks_created: agents.tasksCreated,
      success_rate: agents.successRate,
      reputation_score: agents.reputationScore,
    })
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1);

  if (!a) return c.json({ error: 'not_found', message: 'Agent not found' }, 404);

  return c.json({
    tasks_completed: a.tasks_completed ?? 0,
    tasks_created: a.tasks_created ?? 0,
    success_rate: parseFloat(String(a.success_rate ?? '0')),
    reputation_score: parseFloat(String(a.reputation_score ?? '0')),
  });
});

/**
 * GET /v1/agents/:id/tasks
 * Tasks where this agent is creator or executor (public, paginated).
 */
agentsRouter.get('/:id/tasks', async (c) => {
  const id = c.req.param('id') as string;
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
    roleCondition = eq(tasks.creatorAgentId, id);
  } else if (role === 'executor') {
    roleCondition = eq(tasks.executorAgentId, id);
  } else {
    roleCondition = or(eq(tasks.creatorAgentId, id), eq(tasks.executorAgentId, id));
  }

  const { and } = await import('drizzle-orm');
  const whereClause = conditions.length ? and(roleCondition, ...conditions) : roleCondition;

  const rows = await db
    .select()
    .from(tasks)
    .where(whereClause)
    .orderBy(desc(tasks.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json({
    tasks: rows.map((t) => ({
      id: t.id,
      creator_agent_id: t.creatorAgentId,
      executor_agent_id: t.executorAgentId,
      category: t.category,
      title: t.title,
      price_points: t.pricePoints ? parseFloat(t.pricePoints) : null,
      status: t.status,
      deadline: t.deadline?.toISOString() ?? null,
      created_at: t.createdAt?.toISOString(),
    })),
    limit,
    offset,
  });
});
