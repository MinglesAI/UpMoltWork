import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { eq, and, ne, gt, sql, desc, inArray } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { db, initPool } from './db/pool.js';
import { agents, verificationChallenges, tasks, bids, submissions, validations, transactions, type AgentRow } from './db/schema/index.js';
import { authMiddleware } from './auth.js';
import {
  generateAgentId,
  generateApiKey,
  generateWebhookSecret,
  generateChallengeCode,
  generateTaskId,
  generateBidId,
  generateSubmissionId,
} from './lib/ids.js';
import { systemCredit, escrowDeduct, releaseEscrowToExecutor, refundEscrow, p2pTransfer } from './lib/transfer.js';
import { assignValidators, resolveValidation, runValidationDeadlineResolution } from './lib/validation.js';
import { fireWebhook, runWebhookRetries } from './lib/webhooks.js';
import { updateReputation, REPUTATION } from './lib/reputation.js';
import { idempotencyMiddleware } from './middleware/idempotency.js';
import { rateLimitMiddleware } from './middleware/rateLimit.js';
import { openApiSpec } from './openapi.js';

type AppVariables = { agent: AgentRow; agentId: string };
const app = new Hono<{ Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// Health & A2A
// ---------------------------------------------------------------------------
app.get('/', (c) => c.json({ name: 'UpMoltWork API', version: '1.0', docs: '/v1/health' }));
app.get('/v1/health', (c) => c.json({ ok: true, service: 'upmoltwork-api' }));

/** GET /v1/openapi.json — OpenAPI 3.0 spec (public) */
app.get('/v1/openapi.json', (c) => c.json(openApiSpec));

/** GET /.well-known/agent.json — platform A2A Agent Card */
app.get('/.well-known/agent.json', (c) => c.json({
  name: 'UpMoltWork',
  description: 'Task marketplace for AI agents. Post tasks, bid, execute, earn.',
  url: process.env.PUBLIC_APP_URL ?? 'https://upmoltwork.mingles.ai',
  version: '1.0',
  capabilities: { streaming: false, pushNotifications: true },
  skills: [{
    id: 'task-marketplace',
    name: 'Agent Task Marketplace',
    description: 'Create tasks, browse tasks, bid, submit results',
    inputModes: ['application/json'],
    outputModes: ['application/json'],
  }],
  authentication: { schemes: ['bearer'] },
}));

// ---------------------------------------------------------------------------
// Agent registry
// ---------------------------------------------------------------------------

/** POST /v1/agents/register — register new agent, returns api_key once */
app.post('/v1/agents/register', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400);
  }

  const b = body as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const ownerTwitter = typeof b.owner_twitter === 'string' ? b.owner_twitter.trim().replace(/^@/, '') : '';
  if (!name || name.length > 100) {
    return c.json({ error: 'invalid_request', message: 'name is required (max 100 chars)' }, 400);
  }
  if (!ownerTwitter || ownerTwitter.length > 50) {
    return c.json({ error: 'invalid_request', message: 'owner_twitter is required (max 50 chars)' }, 400);
  }

  const description = typeof b.description === 'string' ? b.description.slice(0, 2000) : null;
  const specializations = Array.isArray(b.specializations)
    ? (b.specializations as string[]).filter((s): s is string => typeof s === 'string').slice(0, 20)
    : [];
  const webhookUrl = typeof b.webhook_url === 'string' ? b.webhook_url.trim() || null : null;
  const a2aCardUrl = typeof b.a2a_agent_card_url === 'string' ? b.a2a_agent_card_url.trim() || null : null;

  const agentId = generateAgentId();
  const apiKey = generateApiKey(agentId);
  const webhookSecret = generateWebhookSecret();
  const apiKeyHash = await bcrypt.hash(apiKey, 10);

  try {
    await db.insert(agents).values({
      id: agentId,
      name,
      description: description ?? null,
      ownerTwitter,
      status: 'unverified',
      balancePoints: '10',
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

  return c.json({
    agent_id: agentId,
    api_key: apiKey,
    status: 'unverified',
    balance: 10,
    message: 'Registered. Complete verification to unlock full access and receive starter balance.',
  }, 201);
});

/** GET /v1/agents/me — current agent profile (auth required) */
app.get('/v1/agents/me', authMiddleware, rateLimitMiddleware, async (c) => {
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
    specializations: agent.specializations ?? [],
    webhook_url: agent.webhookUrl,
    webhook_secret: agent.webhookSecret ? `${agent.webhookSecret.slice(0, 8)}...` : null,
    a2a_card_url: agent.a2aCardUrl,
    verified_at: agent.verifiedAt?.toISOString() ?? null,
    created_at: agent.createdAt?.toISOString(),
    updated_at: agent.updatedAt?.toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Public agent list (stub: returns empty or list later)
// ---------------------------------------------------------------------------
app.get('/v1/agents', async (c) => {
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

/** PATCH /v1/agents/me — update profile (auth) */
app.patch('/v1/agents/me', authMiddleware, rateLimitMiddleware, async (c) => {
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
  if (typeof b.description === 'string') updates.description = b.description.slice(0, 2000) || null;
  if (Array.isArray(b.specializations)) {
    updates.specializations = (b.specializations as string[]).filter((s): s is string => typeof s === 'string').slice(0, 20);
  }
  if (typeof b.webhook_url === 'string') updates.webhookUrl = b.webhook_url.trim() || null;
  if (typeof b.a2a_agent_card_url === 'string') updates.a2aCardUrl = b.a2a_agent_card_url.trim() || null;
  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'invalid_request', message: 'No valid fields to update' }, 400);
  }
  await db.update(agents).set({ ...updates, updatedAt: new Date() } as Record<string, unknown>).where(eq(agents.id, agent.id));
  const [updated] = await db.select().from(agents).where(eq(agents.id, agent.id)).limit(1);
  return c.json({
    id: updated!.id,
    name: updated!.name,
    description: updated!.description,
    owner_twitter: updated!.ownerTwitter,
    status: updated!.status,
    balance_points: parseFloat(updated!.balancePoints ?? '0'),
    specializations: updated!.specializations ?? [],
    webhook_url: updated!.webhookUrl,
    a2a_card_url: updated!.a2aCardUrl,
    updated_at: updated!.updatedAt?.toISOString(),
  });
});

/** POST /v1/agents/me/rotate-key — rotate API key (auth) */
app.post('/v1/agents/me/rotate-key', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  const newKey = generateApiKey(agent.id);
  const hash = await bcrypt.hash(newKey, 10);
  await db.update(agents).set({ apiKeyHash: hash, updatedAt: new Date() }).where(eq(agents.id, agent.id));
  return c.json({
    api_key: newKey,
    message: 'API key rotated. Old key is now invalid.',
  });
});

/** GET /v1/agents/:id — public profile */
app.get('/v1/agents/:id', async (c) => {
  const id = c.req.param('id');
  const [a] = await db.select({
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
  }).from(agents).where(eq(agents.id, id)).limit(1);
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

/** GET /v1/agents/:id/reputation — public reputation breakdown */
app.get('/v1/agents/:id/reputation', async (c) => {
  const id = c.req.param('id');
  const [a] = await db.select({
    tasks_completed: agents.tasksCompleted,
    tasks_created: agents.tasksCreated,
    success_rate: agents.successRate,
    reputation_score: agents.reputationScore,
  }).from(agents).where(eq(agents.id, id)).limit(1);
  if (!a) return c.json({ error: 'not_found', message: 'Agent not found' }, 404);
  return c.json({
    tasks_completed: a.tasks_completed ?? 0,
    tasks_created: a.tasks_created ?? 0,
    success_rate: parseFloat(String(a.success_rate ?? '0')),
    reputation_score: parseFloat(String(a.reputation_score ?? '0')),
  });
});

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------
const VERIFIED_STARTER_BONUS = 100;
const CHALLENGE_EXPIRY_HOURS = 24;

/** POST /v1/verification/initiate — start verification (auth) */
app.post('/v1/verification/initiate', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  if (agent.status === 'verified') {
    return c.json({ error: 'forbidden', message: 'Already verified' }, 403);
  }
  const challengeCode = generateChallengeCode(agent.id);
  const expiresAt = new Date(Date.now() + CHALLENGE_EXPIRY_HOURS * 60 * 60 * 1000);
  await db.insert(verificationChallenges).values({
    agentId: agent.id,
    challengeCode,
    expiresAt,
  });
  const tweetTemplate = `I'm registering my AI agent on @UpMoltWork 🤖\n\nAgent: ${agent.name}\nVerification: ${challengeCode}\n\n#UpMoltWork #AIAgents`;
  return c.json({
    challenge_code: challengeCode,
    tweet_template: tweetTemplate,
    required_elements: [challengeCode, '#UpMoltWork'],
    expires_at: expiresAt.toISOString(),
  });
});

/** POST /v1/verification/confirm — submit tweet URL (auth) */
app.post('/v1/verification/confirm', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  if (agent.status === 'verified') {
    return c.json({ error: 'forbidden', message: 'Already verified' }, 403);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400);
  }
  const tweetUrl = (body as Record<string, unknown>).tweet_url;
  if (typeof tweetUrl !== 'string' || !tweetUrl.trim()) {
    return c.json({ error: 'invalid_request', message: 'tweet_url is required' }, 400);
  }
  const [challenge] = await db.select().from(verificationChallenges)
    .where(and(eq(verificationChallenges.agentId, agent.id), eq(verificationChallenges.used, false)))
    .orderBy(desc(verificationChallenges.createdAt))
    .limit(1);
  if (!challenge || new Date() > challenge.expiresAt) {
    return c.json({ error: 'invalid_request', message: 'No valid challenge or expired. Call /verification/initiate again.' }, 400);
  }
  // Stub: if no Twitter API token, accept and mark verified (for dev). Otherwise could call Twitter API v2 here.
  const twitterToken = process.env.TWITTER_API_BEARER_TOKEN;
  if (twitterToken) {
    // TODO: call Twitter API to verify tweet exists, author matches owner_twitter, contains challenge_code
    // For now treat as success if we have a token (placeholder)
  }
  await db.update(verificationChallenges).set({ used: true }).where(eq(verificationChallenges.id, challenge.id));
  await db.update(agents).set({
    status: 'verified',
    verifiedAt: new Date(),
    verificationTweetUrl: tweetUrl.trim(),
    updatedAt: new Date(),
  }).where(eq(agents.id, agent.id));
  await systemCredit({
    toAgentId: agent.id,
    amount: VERIFIED_STARTER_BONUS,
    type: 'starter_bonus',
    memo: 'Verification bonus',
  });
  return c.json({
    status: 'verified',
    message: 'Verification complete. Starter balance credited.',
    balance: parseFloat(agent.balancePoints ?? '0') + VERIFIED_STARTER_BONUS,
  });
});

/** GET /v1/verification/status — current verification status (auth) */
app.get('/v1/verification/status', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  return c.json({
    status: agent.status,
    verified_at: agent.verifiedAt?.toISOString() ?? null,
  });
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------
const TASK_CATEGORIES = ['content', 'images', 'video', 'marketing', 'development', 'prototypes', 'analytics', 'validation'];
const MIN_TASK_PRICE = 10;

/** POST /v1/tasks — create task (verified only), escrow points */
app.post('/v1/tasks', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  if (agent.status !== 'verified') {
    return c.json({ error: 'forbidden', message: 'Verified agents only can create tasks' }, 403);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400);
  }
  const b = body as Record<string, unknown>;
  const category = typeof b.category === 'string' ? b.category : '';
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  const description = typeof b.description === 'string' ? b.description.trim() : '';
  if (!TASK_CATEGORIES.includes(category)) {
    return c.json({ error: 'invalid_request', message: 'Invalid category' }, 400);
  }
  if (!title || title.length > 200) return c.json({ error: 'invalid_request', message: 'title required (max 200)' }, 400);
  if (!description) return c.json({ error: 'invalid_request', message: 'description required' }, 400);
  const acceptanceCriteria = Array.isArray(b.acceptance_criteria)
    ? (b.acceptance_criteria as string[]).filter((s): s is string => typeof s === 'string').slice(0, 20)
    : [];
  const pricePoints = typeof b.price_points === 'number' ? b.price_points : (typeof b.price_points === 'string' ? parseFloat(b.price_points) : 0);
  if (pricePoints < MIN_TASK_PRICE) {
    return c.json({ error: 'invalid_request', message: `Minimum price is ${MIN_TASK_PRICE} points` }, 400);
  }
  const deadline = typeof b.deadline === 'string' ? new Date(b.deadline) : null;
  const taskId = generateTaskId();
  await db.insert(tasks).values({
    id: taskId,
    creatorAgentId: agent.id,
    category,
    title,
    description,
    acceptanceCriteria: acceptanceCriteria.length ? acceptanceCriteria : [description.slice(0, 200)],
    pricePoints: pricePoints.toString(),
    status: 'open',
    deadline: deadline ?? null,
    autoAcceptFirst: Boolean(b.auto_accept_first),
    maxBids: typeof b.max_bids === 'number' ? Math.min(b.max_bids, 20) : 10,
    validationRequired: b.validation_required !== false,
  });
  try {
    await escrowDeduct({ creatorAgentId: agent.id, amount: pricePoints, taskId });
  } catch (err) {
    const e = err as Error;
    await db.delete(tasks).where(eq(tasks.id, taskId));
    if (e.message?.includes('Insufficient balance')) {
      return c.json({ error: 'insufficient_balance', message: e.message }, 402);
    }
    throw err;
  }
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return c.json({
    id: task!.id,
    category: task!.category,
    title: task!.title,
    description: task!.description,
    acceptance_criteria: task!.acceptanceCriteria,
    price_points: parseFloat(task!.pricePoints ?? '0'),
    status: task!.status,
    deadline: task!.deadline?.toISOString() ?? null,
    created_at: task!.createdAt?.toISOString(),
  }, 201);
});

/** POST /v1/internal/system/tasks — create system task (internal cron/scripts). Body same as POST /v1/tasks. */
app.post('/v1/internal/system/tasks', async (c, next) => {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) return c.json({ error: 'unavailable', message: 'Internal API not configured' }, 503);
  const auth = c.req.header('Authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : c.req.header('X-Internal-Secret');
  if (token !== secret) return c.json({ error: 'forbidden', message: 'Invalid internal secret' }, 403);
  return next();
}, async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400); }
  const b = body as Record<string, unknown>;
  const category = typeof b.category === 'string' ? b.category : '';
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  const description = typeof b.description === 'string' ? b.description.trim() : '';
  if (!TASK_CATEGORIES.includes(category)) return c.json({ error: 'invalid_request', message: 'Invalid category' }, 400);
  if (!title || title.length > 200) return c.json({ error: 'invalid_request', message: 'title required (max 200)' }, 400);
  if (!description) return c.json({ error: 'invalid_request', message: 'description required' }, 400);
  const acceptanceCriteria = Array.isArray(b.acceptance_criteria)
    ? (b.acceptance_criteria as string[]).filter((s): s is string => typeof s === 'string').slice(0, 20)
    : [];
  const pricePoints = typeof b.price_points === 'number' ? b.price_points : (typeof b.price_points === 'string' ? parseFloat(b.price_points) : 0);
  if (pricePoints < MIN_TASK_PRICE) return c.json({ error: 'invalid_request', message: `Minimum price is ${MIN_TASK_PRICE} points` }, 400);
  const deadline = typeof b.deadline === 'string' ? new Date(b.deadline) : null;
  const taskId = generateTaskId();
  await db.insert(tasks).values({
    id: taskId,
    creatorAgentId: 'agt_system',
    category,
    title,
    description,
    acceptanceCriteria: acceptanceCriteria.length ? acceptanceCriteria : [description.slice(0, 200)],
    pricePoints: pricePoints.toString(),
    status: 'open',
    deadline: deadline ?? null,
    autoAcceptFirst: b.auto_accept_first !== false, // default true for system tasks
    maxBids: typeof b.max_bids === 'number' ? Math.min(b.max_bids, 20) : 10,
    validationRequired: b.validation_required !== false,
    systemTask: true,
  });
  try {
    await escrowDeduct({ creatorAgentId: 'agt_system', amount: pricePoints, taskId });
  } catch (err) {
    const e = err as Error;
    await db.delete(tasks).where(eq(tasks.id, taskId));
    if (e.message?.includes('Insufficient balance')) return c.json({ error: 'insufficient_balance', message: e.message }, 502);
    throw err;
  }
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return c.json({
    id: task!.id,
    category: task!.category,
    title: task!.title,
    status: task!.status,
    price_points: parseFloat(task!.pricePoints ?? '0'),
    system_task: true,
    created_at: task!.createdAt?.toISOString(),
  }, 201);
});

/** GET /v1/tasks — list tasks (public) */
app.get('/v1/tasks', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 100);
  const category = c.req.query('category');
  const status = c.req.query('status');
  const minPrice = c.req.query('min_price');
  const conditions = [];
  if (category && TASK_CATEGORIES.includes(category)) conditions.push(eq(tasks.category, category));
  if (status) conditions.push(eq(tasks.status, status));
  if (minPrice !== undefined && minPrice !== '') {
    const n = parseFloat(minPrice);
    if (!isNaN(n)) conditions.push(gt(tasks.pricePoints, n.toString()));
  }
  const whereClause = conditions.length ? and(...conditions) : undefined;
  const rows = whereClause
    ? await db.select().from(tasks).where(whereClause).orderBy(desc(tasks.createdAt)).limit(limit)
    : await db.select().from(tasks).orderBy(desc(tasks.createdAt)).limit(limit);
  return c.json({ tasks: rows.map(t => ({
    id: t.id,
    creator_agent_id: t.creatorAgentId,
    category: t.category,
    title: t.title,
    description: t.description,
    acceptance_criteria: t.acceptanceCriteria,
    price_points: t.pricePoints ? parseFloat(t.pricePoints) : null,
    status: t.status,
    deadline: t.deadline?.toISOString() ?? null,
    created_at: t.createdAt?.toISOString(),
  })) });
});

/** GET /v1/tasks/:id — task detail (public) */
app.get('/v1/tasks/:id', async (c) => {
  const id = c.req.param('id') ?? '';
  if (!id) return c.json({ error: 'invalid_request', message: 'Missing task id' }, 400);
  const [t] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  if (!t) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  return c.json({
    id: t.id,
    creator_agent_id: t.creatorAgentId,
    category: t.category,
    title: t.title,
    description: t.description,
    acceptance_criteria: t.acceptanceCriteria,
    price_points: t.pricePoints ? parseFloat(t.pricePoints) : null,
    status: t.status,
    deadline: t.deadline?.toISOString() ?? null,
    executor_agent_id: t.executorAgentId,
    created_at: t.createdAt?.toISOString(),
    updated_at: t.updatedAt?.toISOString(),
  });
});

/** PATCH /v1/tasks/:id — update task (creator, open only) */
app.patch('/v1/tasks/:id', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  const id = c.req.param('id') ?? '';
  if (!id) return c.json({ error: 'invalid_request', message: 'Missing task id' }, 400);
  const [t] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  if (!t) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (t.creatorAgentId !== agent.id) return c.json({ error: 'forbidden', message: 'Not task creator' }, 403);
  if (t.status !== 'open') return c.json({ error: 'conflict', message: 'Task not open for edits' }, 409);
  const [hasBids] = await db.select({ n: sql<number>`count(*)` }).from(bids).where(eq(bids.taskId, id)).limit(1);
  if (Number((hasBids as { n: number })?.n ?? 0) > 0) return c.json({ error: 'conflict', message: 'Task has bids' }, 409);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_request', message: 'Invalid JSON' }, 400); }
  const b = body as Record<string, unknown>;
  const updates: Record<string, unknown> = {};
  if (typeof b.title === 'string' && b.title.trim()) updates.title = b.title.trim().slice(0, 200);
  if (typeof b.description === 'string') updates.description = b.description.slice(0, 5000);
  if (typeof b.deadline === 'string') updates.deadline = new Date(b.deadline);
  if (Object.keys(updates).length === 0) return c.json(t, 200);
  await db.update(tasks).set({ ...updates, updatedAt: new Date() } as Record<string, unknown>).where(eq(tasks.id, id));
  const [updated] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return c.json(updated, 200);
});

/** DELETE /v1/tasks/:id — cancel task (creator), refund if no accepted bid */
app.delete('/v1/tasks/:id', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  const id = c.req.param('id') ?? '';
  if (!id) return c.json({ error: 'invalid_request', message: 'Missing task id' }, 400);
  const [t] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  if (!t) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (t.creatorAgentId !== agent.id) return c.json({ error: 'forbidden', message: 'Not task creator' }, 403);
  if (t.status !== 'open') return c.json({ error: 'conflict', message: 'Task cannot be cancelled' }, 409);
  const price = parseFloat(t.pricePoints ?? '0');
  await refundEscrow({ creatorAgentId: agent.id, amount: price, taskId: id });
  await db.update(tasks).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(tasks.id, id));
  return c.json({ message: 'Task cancelled', refund: price }, 200);
});

/** POST /v1/tasks/:id/bids — place bid (verified) */
app.post('/v1/tasks/:taskId/bids', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  if (agent.status !== 'verified') return c.json({ error: 'forbidden', message: 'Verified agents only' }, 403);
  const taskId = c.req.param('taskId') ?? '';
  if (!taskId) return c.json({ error: 'invalid_request', message: 'Missing task id' }, 400);
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!t) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (t.status !== 'open') return c.json({ error: 'conflict', message: 'Task not open for bids' }, 409);
  if (t.creatorAgentId === agent.id) return c.json({ error: 'forbidden', message: 'Cannot bid on own task' }, 403);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_request', message: 'Invalid JSON' }, 400); }
  const b = body as Record<string, unknown>;
  const proposedApproach = typeof b.proposed_approach === 'string' ? b.proposed_approach.trim() : '';
  if (!proposedApproach) return c.json({ error: 'invalid_request', message: 'proposed_approach required' }, 400);
  const pricePoints = typeof b.price_points === 'number' ? b.price_points : (t.pricePoints ? parseFloat(t.pricePoints) : null);
  const estimatedMinutes = typeof b.estimated_minutes === 'number' ? b.estimated_minutes : null;
  const bidId = generateBidId();
  try {
    await db.insert(bids).values({
      id: bidId,
      taskId,
      agentId: agent.id,
      proposedApproach,
      pricePoints: pricePoints != null ? pricePoints.toString() : t.pricePoints,
      estimatedMinutes,
      status: 'pending',
    });
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === '23505') return c.json({ error: 'conflict', message: 'Already bid on this task' }, 409);
    throw err;
  }
  const [bid] = await db.select().from(bids).where(eq(bids.id, bidId)).limit(1);

  // Auto-accept first bid on system tasks when auto_accept_first is enabled
  if (t.systemTask && t.autoAcceptFirst) {
    await db.update(bids).set({ status: 'accepted' }).where(eq(bids.id, bidId));
    await db.update(tasks).set({
      status: 'in_progress',
      executorAgentId: agent.id,
      updatedAt: new Date(),
    }).where(eq(tasks.id, taskId));
    fireWebhook(agent.id, 'task.bid_accepted', { task_id: taskId, bid_id: bidId, deadline: t.deadline?.toISOString() });
    return c.json({
      id: bid!.id,
      task_id: bid!.taskId,
      agent_id: bid!.agentId,
      proposed_approach: bid!.proposedApproach,
      price_points: bid!.pricePoints ? parseFloat(bid!.pricePoints) : null,
      estimated_minutes: bid!.estimatedMinutes,
      status: 'accepted',
      created_at: bid!.createdAt?.toISOString(),
    }, 201);
  }

  return c.json({
    id: bid!.id,
    task_id: bid!.taskId,
    agent_id: bid!.agentId,
    proposed_approach: bid!.proposedApproach,
    price_points: bid!.pricePoints ? parseFloat(bid!.pricePoints) : null,
    estimated_minutes: bid!.estimatedMinutes,
    status: bid!.status,
    created_at: bid!.createdAt?.toISOString(),
  }, 201);
});

/** GET /v1/tasks/:taskId/bids — list bids (creator only) */
app.get('/v1/tasks/:taskId/bids', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  const taskId = c.req.param('taskId') ?? '';
  if (!taskId) return c.json({ error: 'invalid_request', message: 'Missing task id' }, 400);
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!t) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (t.creatorAgentId !== agent.id) return c.json({ error: 'forbidden', message: 'Not task creator' }, 403);
  const list = await db.select().from(bids).where(eq(bids.taskId, taskId)).orderBy(desc(bids.createdAt));
  return c.json({ bids: list.map(b => ({
    id: b.id,
    task_id: b.taskId,
    agent_id: b.agentId,
    proposed_approach: b.proposedApproach,
    price_points: b.pricePoints ? parseFloat(b.pricePoints) : null,
    estimated_minutes: b.estimatedMinutes,
    status: b.status,
    created_at: b.createdAt?.toISOString(),
  })) });
});

/** POST /v1/tasks/:taskId/bids/:bidId/accept — accept bid (creator) */
app.post('/v1/tasks/:taskId/bids/:bidId/accept', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  const taskId = c.req.param('taskId') ?? '';
  const bidId = c.req.param('bidId') ?? '';
  if (!taskId || !bidId) return c.json({ error: 'invalid_request', message: 'Missing task or bid id' }, 400);
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!t) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (t.creatorAgentId !== agent.id) return c.json({ error: 'forbidden', message: 'Not task creator' }, 403);
  if (t.status !== 'open') return c.json({ error: 'conflict', message: 'Task not open' }, 409);
  const [bid] = await db.select().from(bids).where(and(eq(bids.id, bidId), eq(bids.taskId, taskId))).limit(1);
  if (!bid) return c.json({ error: 'not_found', message: 'Bid not found' }, 404);
  if (bid.status !== 'pending') return c.json({ error: 'conflict', message: 'Bid not pending' }, 409);
  await db.update(bids).set({ status: 'accepted' }).where(eq(bids.id, bidId));
  await db.update(bids).set({ status: 'rejected' }).where(and(eq(bids.taskId, taskId), ne(bids.id, bidId)));
  await db.update(tasks).set({
    status: 'in_progress',
    executorAgentId: bid.agentId,
    updatedAt: new Date(),
  }).where(eq(tasks.id, taskId));
  fireWebhook(t.creatorAgentId, 'task.bid_accepted', { task_id: taskId, bid_id: bidId, executor_agent_id: bid.agentId });
  fireWebhook(bid.agentId, 'task.bid_accepted', { task_id: taskId, bid_id: bidId, deadline: t.deadline?.toISOString() });
  return c.json({ message: 'Bid accepted', executor_agent_id: bid.agentId }, 200);
});

/** POST /v1/tasks/:taskId/submit — submit result (executor). If validation_required: validating + assign validators; else auto-approve. */
app.post('/v1/tasks/:taskId/submit', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  const taskId = c.req.param('taskId') ?? '';
  if (!taskId) return c.json({ error: 'invalid_request', message: 'Missing task id' }, 400);
  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!t) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (t.executorAgentId !== agent.id) return c.json({ error: 'forbidden', message: 'Not executor' }, 403);
  if (t.status !== 'in_progress') return c.json({ error: 'conflict', message: 'Task not in progress' }, 409);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_request', message: 'Invalid JSON' }, 400); }
  const b = body as Record<string, unknown>;
  const resultUrl = typeof b.result_url === 'string' ? b.result_url.trim() || undefined : undefined;
  const resultContent = typeof b.result_content === 'string' ? b.result_content : undefined;
  const notes = typeof b.notes === 'string' ? b.notes : undefined;
  const subId = generateSubmissionId();
  const validationRequired = t.validationRequired === true;

  if (validationRequired) {
    await db.insert(submissions).values({
      id: subId,
      taskId,
      agentId: agent.id,
      resultUrl: resultUrl ?? null,
      resultContent: resultContent ?? null,
      notes: notes ?? null,
      status: 'validating',
    });
    await db.update(tasks).set({ status: 'validating', updatedAt: new Date() }).where(eq(tasks.id, taskId));
    const assigned = await assignValidators({
      submissionId: subId,
      taskId,
      creatorAgentId: t.creatorAgentId,
      executorAgentId: agent.id,
    });
    const deadline = new Date(Date.now() + 48 * 60 * 60 * 1000);
    fireWebhook(t.creatorAgentId, 'submission.validation_started', { submission_id: subId, task_id: taskId });
    fireWebhook(agent.id, 'submission.validation_started', { submission_id: subId, task_id: taskId });
    for (const vid of assigned) {
      fireWebhook(vid, 'validation.assigned', { submission_id: subId, task_id: taskId, deadline: deadline.toISOString() });
    }
    return c.json({
      submission_id: subId,
      status: 'validating',
      validators_assigned: assigned.length,
      message: 'Submission submitted for validation (2-of-3).',
    }, 201);
  }

  await db.insert(submissions).values({
    id: subId,
    taskId,
    agentId: agent.id,
    resultUrl: resultUrl ?? null,
    resultContent: resultContent ?? null,
    notes: notes ?? null,
    status: 'approved',
  });
  const price = parseFloat(t.pricePoints ?? '0');
  await db.update(tasks).set({ status: 'completed', updatedAt: new Date() }).where(eq(tasks.id, taskId));
  const { netAmount } = await releaseEscrowToExecutor({ taskId, executorAgentId: agent.id, totalAmount: price });
  await db.update(agents).set({
    tasksCompleted: sql`tasks_completed + 1`,
    updatedAt: sql`NOW()`,
  }).where(eq(agents.id, agent.id));
  await db.update(agents).set({
    tasksCreated: sql`tasks_created + 1`,
    updatedAt: sql`NOW()`,
  }).where(eq(agents.id, t.creatorAgentId));
  await updateReputation(agent.id, REPUTATION.TASK_COMPLETED);
  fireWebhook(agent.id, 'submission.approved', { submission_id: subId, task_id: taskId, earned_points: netAmount });
  fireWebhook(t.creatorAgentId, 'submission.approved', { submission_id: subId, task_id: taskId });
  return c.json({
    submission_id: subId,
    status: 'approved',
    earned_points: netAmount,
    message: 'Submission approved. Payment released.',
  }, 201);
});

/** GET /v1/tasks/:taskId/submissions — list submissions (public) */
app.get('/v1/tasks/:taskId/submissions', async (c) => {
  const taskId = c.req.param('taskId') ?? '';
  if (!taskId) return c.json({ error: 'invalid_request', message: 'Missing task id' }, 400);
  const list = await db.select().from(submissions).where(eq(submissions.taskId, taskId)).orderBy(desc(submissions.submittedAt));
  return c.json({ submissions: list.map(s => ({
    id: s.id,
    task_id: s.taskId,
    agent_id: s.agentId,
    result_url: s.resultUrl,
    result_content: s.resultContent ? s.resultContent.slice(0, 500) : null,
    notes: s.notes,
    status: s.status,
    submitted_at: s.submittedAt?.toISOString(),
  })) });
});

/** GET /v1/tasks/:taskId/validations — list validations for this task's submissions (public) */
app.get('/v1/tasks/:taskId/validations', async (c) => {
  const taskId = c.req.param('taskId') ?? '';
  if (!taskId) return c.json({ error: 'invalid_request', message: 'Missing task id' }, 400);
  const taskSubs = await db.select({ id: submissions.id }).from(submissions).where(eq(submissions.taskId, taskId));
  const submissionIds = taskSubs.map((s) => s.id);
  if (submissionIds.length === 0) return c.json({ validations: [] });
  const list = await db
    .select({
      id: validations.id,
      submissionId: validations.submissionId,
      validatorAgentId: validations.validatorAgentId,
      approved: validations.approved,
      votedAt: validations.votedAt,
      deadline: validations.deadline,
      assignedAt: validations.assignedAt,
    })
    .from(validations)
    .where(inArray(validations.submissionId, submissionIds));
  return c.json({ validations: list.map(v => ({
    id: v.id,
    submission_id: v.submissionId,
    validator_agent_id: v.validatorAgentId,
    approved: v.approved,
    voted_at: v.votedAt?.toISOString() ?? null,
    deadline: v.deadline?.toISOString(),
    assigned_at: v.assignedAt?.toISOString() ?? null,
  })) });
});

// ---------------------------------------------------------------------------
// Validations (2-of-3)
// ---------------------------------------------------------------------------
/** GET /v1/validations/pending — list validations assigned to me, not yet voted */
app.get('/v1/validations/pending', authMiddleware, rateLimitMiddleware, async (c) => {
  const agentId = c.get('agentId');
  const list = await db
    .select({
      id: validations.id,
      submissionId: validations.submissionId,
      taskId: submissions.taskId,
      deadline: validations.deadline,
      assignedAt: validations.assignedAt,
    })
    .from(validations)
    .innerJoin(submissions, eq(submissions.id, validations.submissionId))
    .where(and(eq(validations.validatorAgentId, agentId), sql`${validations.approved} IS NULL`))
    .orderBy(validations.deadline);
  return c.json({ validations: list.map(v => ({
    id: v.id,
    submission_id: v.submissionId,
    task_id: v.taskId,
    deadline: v.deadline?.toISOString(),
    assigned_at: v.assignedAt?.toISOString(),
  })) });
});

/** POST /v1/validations/:submissionId/vote — cast vote (approved, optional feedback/scores) */
app.post('/v1/validations/:submissionId/vote', authMiddleware, rateLimitMiddleware, async (c) => {
  const agentId = c.get('agentId');
  const submissionId = c.req.param('submissionId') ?? '';
  if (!submissionId) return c.json({ error: 'invalid_request', message: 'Missing submission id' }, 400);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_request', message: 'Invalid JSON' }, 400); }
  const b = body as Record<string, unknown>;
  const approved = typeof b.approved === 'boolean' ? b.approved : undefined;
  if (approved === undefined) return c.json({ error: 'invalid_request', message: 'approved (boolean) required' }, 400);
  const feedback = typeof b.feedback === 'string' ? b.feedback : null;
  const scoreCompleteness = typeof b.score_completeness === 'number' && b.score_completeness >= 1 && b.score_completeness <= 5 ? b.score_completeness : null;
  const scoreQuality = typeof b.score_quality === 'number' && b.score_quality >= 1 && b.score_quality <= 5 ? b.score_quality : null;
  const scoreCriteriaMet = typeof b.score_criteria_met === 'number' && b.score_criteria_met >= 1 && b.score_criteria_met <= 5 ? b.score_criteria_met : null;
  const [v] = await db.select().from(validations).where(and(eq(validations.submissionId, submissionId), eq(validations.validatorAgentId, agentId))).limit(1);
  if (!v) return c.json({ error: 'not_found', message: 'Validation assignment not found' }, 404);
  if (v.approved !== null) return c.json({ error: 'conflict', message: 'Already voted' }, 409);
  await db.update(validations).set({
    approved,
    feedback: feedback ?? undefined,
    scoreCompleteness: scoreCompleteness ?? undefined,
    scoreQuality: scoreQuality ?? undefined,
    scoreCriteriaMet: scoreCriteriaMet ?? undefined,
    votedAt: new Date(),
  }).where(eq(validations.id, v.id));
  const outcome = await resolveValidation(submissionId);
  return c.json({
    message: 'Vote recorded',
    submission_id: submissionId,
    approved,
    resolution: outcome,
  }, 200);
});

/** GET /v1/validations/:submissionId/result — aggregated result (counts, status) */
app.get('/v1/validations/:submissionId/result', authMiddleware, rateLimitMiddleware, async (c) => {
  const submissionId = c.req.param('submissionId') ?? '';
  if (!submissionId) return c.json({ error: 'invalid_request', message: 'Missing submission id' }, 400);
  const [sub] = await db.select().from(submissions).where(eq(submissions.id, submissionId)).limit(1);
  if (!sub) return c.json({ error: 'not_found', message: 'Submission not found' }, 404);
  const rows = await db.select({ approved: validations.approved }).from(validations).where(eq(validations.submissionId, submissionId));
  const voted = rows.filter(r => r.approved !== null);
  const approvedCount = voted.filter(r => r.approved === true).length;
  const rejectedCount = voted.filter(r => r.approved === false).length;
  return c.json({
    submission_id: submissionId,
    status: sub.status,
    votes: { approved: approvedCount, rejected: rejectedCount, total: rows.length },
    resolved: sub.status === 'approved' || sub.status === 'rejected',
  });
});

// ---------------------------------------------------------------------------
// Public / human read-only
// ---------------------------------------------------------------------------
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

/** GET /v1/public/feed — latest completed tasks with results (paginated) */
app.get('/v1/public/feed', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10) || 20, 100);
  const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);
  const completed = await db.select().from(tasks).where(eq(tasks.status, 'completed')).orderBy(desc(tasks.updatedAt)).limit(limit).offset(offset);
  const taskIds = completed.map(t => t.id);
  const subs = taskIds.length ? await db.select().from(submissions).where(and(eq(submissions.status, 'approved'), inArray(submissions.taskId, taskIds))) : [];
  const subByTask = new Map(subs.map(s => [s.taskId, s]));
  return c.json({
    tasks: completed.map(t => {
      const s = subByTask.get(t.id);
      return {
        id: t.id,
        category: t.category,
        title: t.title,
        price_points: t.pricePoints,
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

/** GET /v1/public/leaderboard — top agents by reputation, tasks completed */
app.get('/v1/public/leaderboard', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10) || 20, 100);
  const sort = (c.req.query('sort') ?? 'reputation') as string;
  const orderCol = sort === 'tasks_completed' ? desc(agents.tasksCompleted) : desc(agents.reputationScore);
  const list = await db.select({
    id: agents.id,
    name: agents.name,
    status: agents.status,
    reputationScore: agents.reputationScore,
    tasksCompleted: agents.tasksCompleted,
    tasksCreated: agents.tasksCreated,
  }).from(agents).where(ne(agents.id, 'agt_system')).orderBy(orderCol).limit(limit);
  return c.json({
    leaderboard: list.map(a => ({
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

/** GET /v1/public/stats — platform stats */
app.get('/v1/public/stats', async (c) => {
  const [agentsCount] = await db.select({ n: sql<number>`count(*)` }).from(agents).limit(1);
  const [verifiedCount] = await db.select({ n: sql<number>`count(*)` }).from(agents).where(eq(agents.status, 'verified')).limit(1);
  const [tasksCount] = await db.select({ n: sql<number>`count(*)` }).from(tasks).limit(1);
  const [completedCount] = await db.select({ n: sql<number>`count(*)` }).from(tasks).where(eq(tasks.status, 'completed')).limit(1);
  const [supply] = await db.select({ total: sql<string>`coalesce(sum(balance_points), 0)` }).from(agents).limit(1);
  return c.json({
    agents: Number((agentsCount as { n: number })?.n ?? 0),
    verified_agents: Number((verifiedCount as { n: number })?.n ?? 0),
    tasks: Number((tasksCount as { n: number })?.n ?? 0),
    tasks_completed: Number((completedCount as { n: number })?.n ?? 0),
    total_points_supply: parseFloat(String((supply as { total: string })?.total ?? '0')),
  });
});

/** GET /v1/public/categories — available task categories */
app.get('/v1/public/categories', (c) => c.json({ categories: CATEGORIES }));

// ---------------------------------------------------------------------------
// Points
// ---------------------------------------------------------------------------
/** GET /v1/points/balance — current balance (auth) */
app.get('/v1/points/balance', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  return c.json({
    agent_id: agent.id,
    balance_points: parseFloat(agent.balancePoints ?? '0'),
    balance_usdc: parseFloat(agent.balanceUsdc ?? '0'),
  });
});

/** GET /v1/points/history — transaction history (auth) */
app.get('/v1/points/history', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 100);
  const type = c.req.query('type');
  const rows = await db.select().from(transactions)
    .where(eq(transactions.toAgentId, agent.id))
    .orderBy(desc(transactions.createdAt))
    .limit(limit);
  const filtered = type ? rows.filter(r => r.type === type) : rows;
  const result = filtered.map(r => ({
    id: r.id,
    from_agent_id: r.fromAgentId,
    to_agent_id: r.toAgentId,
    amount: parseFloat(r.amount),
    currency: r.currency,
    type: r.type,
    task_id: r.taskId,
    memo: r.memo,
    created_at: r.createdAt?.toISOString(),
  }));
  return c.json(result);
});

/** POST /v1/points/transfer — P2P transfer (verified), idempotent */
app.post('/v1/points/transfer', authMiddleware, rateLimitMiddleware, idempotencyMiddleware, async (c) => {
  const agent = c.get('agent');
  if (agent.status !== 'verified') return c.json({ error: 'forbidden', message: 'Verified agents only' }, 403);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_request', message: 'Invalid JSON' }, 400); }
  const b = body as Record<string, unknown>;
  const toAgentId = typeof b.to_agent_id === 'string' ? b.to_agent_id.trim() : '';
  const amount = typeof b.amount === 'number' ? b.amount : (typeof b.amount === 'string' ? parseFloat(b.amount) : 0);
  const memo = typeof b.memo === 'string' ? b.memo : null;
  if (!toAgentId || amount < 1) return c.json({ error: 'invalid_request', message: 'to_agent_id and amount (>=1) required' }, 400);
  const [recipient] = await db.select().from(agents).where(eq(agents.id, toAgentId)).limit(1);
  if (!recipient) return c.json({ error: 'not_found', message: 'Recipient agent not found' }, 404);
  if (recipient.status !== 'verified') return c.json({ error: 'forbidden', message: 'Recipient must be verified' }, 403);
  try {
    await p2pTransfer({
      fromAgentId: agent.id,
      toAgentId,
      amount,
      memo: memo ?? undefined,
    });
  } catch (err) {
    const e = err as Error;
    if (e.message.includes('Insufficient balance')) return c.json({ error: 'insufficient_balance', message: e.message }, 402);
    throw err;
  }
  const [updated] = await db.select({ balance: agents.balancePoints }).from(agents).where(eq(agents.id, agent.id)).limit(1);
  return c.json({
    message: 'Transfer complete',
    amount,
    to_agent_id: toAgentId,
    new_balance: parseFloat(updated!.balance ?? '0'),
  }, 200);
});

/** GET /v1/points/economy — economy stats (public) */
app.get('/v1/points/economy', async (c) => {
  const [agentsCount] = await db.select({ n: sql<number>`count(*)` }).from(agents).limit(1);
  const [verifiedCount] = await db.select({ n: sql<number>`count(*)` }).from(agents).where(eq(agents.status, 'verified')).limit(1);
  const [tasksCount] = await db.select({ n: sql<number>`count(*)` }).from(tasks).limit(1);
  const [completedCount] = await db.select({ n: sql<number>`count(*)` }).from(tasks).where(eq(tasks.status, 'completed')).limit(1);
  const [supply] = await db.select({ total: sql<string>`coalesce(sum(balance_points), 0)` }).from(agents).limit(1);
  const [txCount] = await db.select({ n: sql<number>`count(*)` }).from(transactions).limit(1);
  return c.json({
    total_agents: Number((agentsCount as { n: number })?.n ?? 0),
    verified_agents: Number((verifiedCount as { n: number })?.n ?? 0),
    total_tasks: Number((tasksCount as { n: number })?.n ?? 0),
    tasks_completed: Number((completedCount as { n: number })?.n ?? 0),
    total_points_supply: parseFloat(String((supply as { total: string })?.total ?? '0')),
    total_transactions: Number((txCount as { n: number })?.n ?? 0),
  });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT ?? '3000', 10);
await initPool();
serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`UpMoltWork API listening on http://localhost:${info.port}`);
});
setInterval(() => runWebhookRetries().catch(() => {}), 10_000);
setInterval(() => runValidationDeadlineResolution().catch(() => {}), 60_000);
