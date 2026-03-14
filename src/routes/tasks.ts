import { Hono } from 'hono';
import { eq, and, ne, gt, desc, sql, inArray } from 'drizzle-orm';
import { db } from '../db/pool.js';
import { agents, tasks, bids, submissions, validations, a2aTaskContexts, taskRatings, type AgentRow } from '../db/schema/index.js';
import { authMiddleware } from '../auth.js';
import { generateTaskId, generateBidId, generateSubmissionId, generateRatingId } from '../lib/ids.js';
import {
  escrowDeduct,
  releaseEscrowToExecutor,
  refundEscrow,
} from '../lib/transfer.js';
import { assignValidators, resolveValidation } from '../lib/validation.js';
import { fireWebhook } from '../lib/webhooks.js';
import { updateReputation, REPUTATION, RATING_DELTA } from '../lib/reputation.js';
import { rateLimitMiddleware } from '../middleware/rateLimit.js';
import { fireA2APushAsync } from '../a2a/push.js';
import { umwStatusToA2A } from '../a2a/handler.js';

type AppVariables = { agent: AgentRow; agentId: string };

export const TASK_CATEGORIES = [
  'content',
  'images',
  'video',
  'marketing',
  'development',
  'prototypes',
  'analytics',
  'validation',
] as const;

const MIN_TASK_PRICE = 10;

export const tasksRouter = new Hono<{ Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * POST /v1/tasks
 * Create a new task (verified agents only). Escrows points on creation.
 */
tasksRouter.post('/', authMiddleware, rateLimitMiddleware, async (c) => {
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

  if (!TASK_CATEGORIES.includes(category as typeof TASK_CATEGORIES[number])) {
    return c.json({ error: 'invalid_request', message: 'Invalid category' }, 400);
  }
  if (!title || title.length > 200) {
    return c.json({ error: 'invalid_request', message: 'title required (max 200)' }, 400);
  }
  if (!description) {
    return c.json({ error: 'invalid_request', message: 'description required' }, 400);
  }

  const acceptanceCriteria = Array.isArray(b.acceptance_criteria)
    ? (b.acceptance_criteria as string[])
        .filter((s): s is string => typeof s === 'string')
        .slice(0, 20)
    : [];
  const pricePoints =
    typeof b.price_points === 'number'
      ? b.price_points
      : typeof b.price_points === 'string'
        ? parseFloat(b.price_points)
        : 0;

  if (pricePoints < MIN_TASK_PRICE) {
    return c.json(
      { error: 'invalid_request', message: `Minimum price is ${MIN_TASK_PRICE} points` },
      400,
    );
  }

  const deadline = typeof b.deadline === 'string' ? new Date(b.deadline) : null;
  const taskId = generateTaskId();

  await db.insert(tasks).values({
    id: taskId,
    creatorAgentId: agent.id,
    category,
    title,
    description,
    acceptanceCriteria: acceptanceCriteria.length
      ? acceptanceCriteria
      : [description.slice(0, 200)],
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
  return c.json(
    {
      id: task!.id,
      category: task!.category,
      title: task!.title,
      description: task!.description,
      acceptance_criteria: task!.acceptanceCriteria,
      price_points: parseFloat(task!.pricePoints ?? '0'),
      status: task!.status,
      deadline: task!.deadline?.toISOString() ?? null,
      created_at: task!.createdAt?.toISOString(),
    },
    201,
  );
});

/**
 * GET /v1/tasks
 * List tasks with optional filters (public, paginated).
 */
tasksRouter.get('/', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 100);
  const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);
  const category = c.req.query('category');
  const status = c.req.query('status');
  const minPrice = c.req.query('min_price');
  const creatorAgentId = c.req.query('creator_agent_id');
  const executorAgentId = c.req.query('executor_agent_id');

  const conditions = [];
  if (category && TASK_CATEGORIES.includes(category as typeof TASK_CATEGORIES[number])) {
    conditions.push(eq(tasks.category, category));
  }
  if (status) conditions.push(eq(tasks.status, status));
  if (minPrice !== undefined && minPrice !== '') {
    const n = parseFloat(minPrice);
    if (!isNaN(n)) conditions.push(gt(tasks.pricePoints, n.toString()));
  }
  if (creatorAgentId) conditions.push(eq(tasks.creatorAgentId, creatorAgentId));
  if (executorAgentId) conditions.push(eq(tasks.executorAgentId, executorAgentId));

  const whereClause = conditions.length ? and(...conditions) : undefined;
  const rows = whereClause
    ? await db
        .select()
        .from(tasks)
        .where(whereClause)
        .orderBy(desc(tasks.createdAt))
        .limit(limit)
        .offset(offset)
    : await db
        .select()
        .from(tasks)
        .orderBy(desc(tasks.createdAt))
        .limit(limit)
        .offset(offset);

  return c.json({
    tasks: rows.map((t) => ({
      id: t.id,
      creator_agent_id: t.creatorAgentId,
      category: t.category,
      title: t.title,
      description: t.description,
      acceptance_criteria: t.acceptanceCriteria,
      price_points: t.pricePoints ? parseFloat(t.pricePoints) : null,
      price_usdc: t.priceUsdc ? parseFloat(t.priceUsdc) : null,
      payment_mode: t.paymentMode ?? 'points',
      escrow_tx_hash: t.escrowTxHash ?? null,
      status: t.status,
      deadline: t.deadline?.toISOString() ?? null,
      created_at: t.createdAt?.toISOString(),
    })),
    limit,
    offset,
  });
});

/**
 * GET /v1/tasks/:id
 * Task detail (public).
 */
tasksRouter.get('/:id', async (c) => {
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
    price_usdc: t.priceUsdc ? parseFloat(t.priceUsdc) : null,
    payment_mode: t.paymentMode ?? 'points',
    escrow_tx_hash: t.escrowTxHash ?? null,
    status: t.status,
    deadline: t.deadline?.toISOString() ?? null,
    executor_agent_id: t.executorAgentId,
    created_at: t.createdAt?.toISOString(),
    updated_at: t.updatedAt?.toISOString(),
  });
});

/**
 * PATCH /v1/tasks/:id
 * Update task title, description, or deadline (creator only, open tasks with no bids).
 */
tasksRouter.patch('/:id', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  const id = c.req.param('id') ?? '';
  if (!id) return c.json({ error: 'invalid_request', message: 'Missing task id' }, 400);

  const [t] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  if (!t) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (t.creatorAgentId !== agent.id)
    return c.json({ error: 'forbidden', message: 'Not task creator' }, 403);
  if (t.status !== 'open')
    return c.json({ error: 'conflict', message: 'Task not open for edits' }, 409);

  const [hasBids] = await db
    .select({ n: sql<number>`count(*)` })
    .from(bids)
    .where(eq(bids.taskId, id))
    .limit(1);
  if (Number((hasBids as { n: number })?.n ?? 0) > 0) {
    return c.json({ error: 'conflict', message: 'Task has bids' }, 409);
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
  if (typeof b.deadline === 'string') updates.deadline = new Date(b.deadline);
  if (Object.keys(updates).length === 0) return c.json(t, 200);

  await db
    .update(tasks)
    .set({ ...updates, updatedAt: new Date() } as Record<string, unknown>)
    .where(eq(tasks.id, id));

  const [updated] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return c.json(updated, 200);
});

/**
 * DELETE /v1/tasks/:id
 * Cancel task (creator only, open tasks). Refunds escrowed points.
 */
tasksRouter.delete('/:id', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  const id = c.req.param('id') ?? '';
  if (!id) return c.json({ error: 'invalid_request', message: 'Missing task id' }, 400);

  const [t] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  if (!t) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (t.creatorAgentId !== agent.id)
    return c.json({ error: 'forbidden', message: 'Not task creator' }, 403);
  if (t.status !== 'open')
    return c.json({ error: 'conflict', message: 'Task cannot be cancelled' }, 409);

  const price = parseFloat(t.pricePoints ?? '0');
  await refundEscrow({ creatorAgentId: agent.id, amount: price, taskId: id });
  await db.update(tasks).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(tasks.id, id));

  // Fire A2A push notification if task was created via A2A
  const [a2aCtx] = await db.select().from(a2aTaskContexts).where(eq(a2aTaskContexts.umwTaskId, id)).limit(1);
  if (a2aCtx?.pushWebhookUrl) {
    fireA2APushAsync(a2aCtx, {
      taskId: a2aCtx.a2aTaskId,
      contextId: a2aCtx.contextId ?? undefined,
      status: { state: umwStatusToA2A('cancelled'), timestamp: new Date().toISOString() },
      final: true,
    });
  }

  return c.json({ message: 'Task cancelled', refund: price }, 200);
});

// ---------------------------------------------------------------------------
// Bids
// ---------------------------------------------------------------------------

/**
 * POST /v1/tasks/:taskId/bids
 * Place a bid on a task (verified agents only, cannot bid own task).
 * Auto-accepts first bid on system tasks with auto_accept_first enabled.
 */
tasksRouter.post('/:taskId/bids', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  if (agent.status !== 'verified') {
    return c.json({ error: 'forbidden', message: 'Verified agents only' }, 403);
  }

  const taskId = c.req.param('taskId') ?? '';
  if (!taskId) return c.json({ error: 'invalid_request', message: 'Missing task id' }, 400);

  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!t) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (t.status !== 'open')
    return c.json({ error: 'conflict', message: 'Task not open for bids' }, 409);
  if (t.creatorAgentId === agent.id)
    return c.json({ error: 'forbidden', message: 'Cannot bid on own task' }, 403);

  // x402: USDC tasks require bidder to have an evm_address for payout
  if (t.paymentMode === 'usdc' && !agent.evmAddress) {
    return c.json(
      {
        error: 'evm_address_required',
        message: 'USDC tasks require an EVM address. Set it via PATCH /v1/agents/me with {"evm_address": "0x..."}',
      },
      422,
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Invalid JSON' }, 400);
  }

  const b = body as Record<string, unknown>;
  const proposedApproach =
    typeof b.proposed_approach === 'string' ? b.proposed_approach.trim() : '';
  if (!proposedApproach) {
    return c.json({ error: 'invalid_request', message: 'proposed_approach required' }, 400);
  }

  const pricePoints =
    typeof b.price_points === 'number'
      ? b.price_points
      : t.pricePoints
        ? parseFloat(t.pricePoints)
        : null;
  const estimatedMinutes =
    typeof b.estimated_minutes === 'number' ? b.estimated_minutes : null;

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
    if (e.code === '23505') {
      return c.json({ error: 'conflict', message: 'Already bid on this task' }, 409);
    }
    throw err;
  }

  const [bid] = await db.select().from(bids).where(eq(bids.id, bidId)).limit(1);

  // Auto-accept first bid on system tasks when auto_accept_first is enabled.
  // Guard against concurrent bids with atomic status check.
  if (t.systemTask && t.autoAcceptFirst) {
    const taskUpdate = await db
      .update(tasks)
      .set({ status: 'in_progress', executorAgentId: agent.id, updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, 'open')));

    if ((taskUpdate as unknown as { rowCount: number }).rowCount === 0) {
      // Race condition: another bid already claimed the task — return pending
      return c.json(formatBid(bid!), 201);
    }

    await db.update(bids).set({ status: 'accepted' }).where(eq(bids.id, bidId));
    await db
      .update(bids)
      .set({ status: 'rejected' })
      .where(and(eq(bids.taskId, taskId), ne(bids.id, bidId)));

    fireWebhook(agent.id, 'task.bid_accepted', {
      task_id: taskId,
      bid_id: bidId,
      deadline: t.deadline?.toISOString(),
    });

    // A2A push: task moved to working
    const [autoA2aCtx] = await db.select().from(a2aTaskContexts).where(eq(a2aTaskContexts.umwTaskId, taskId)).limit(1);
    if (autoA2aCtx?.pushWebhookUrl) {
      fireA2APushAsync(autoA2aCtx, {
        taskId: autoA2aCtx.a2aTaskId,
        contextId: autoA2aCtx.contextId ?? undefined,
        status: { state: umwStatusToA2A('in_progress'), timestamp: new Date().toISOString() },
        final: false,
      });
    }

    return c.json({ ...formatBid(bid!), status: 'accepted' }, 201);
  }

  return c.json(formatBid(bid!), 201);
});

/**
 * GET /v1/tasks/:taskId/bids
 * List all bids on a task (creator only).
 */
tasksRouter.get('/:taskId/bids', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  const taskId = c.req.param('taskId') ?? '';
  if (!taskId) return c.json({ error: 'invalid_request', message: 'Missing task id' }, 400);

  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!t) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (t.creatorAgentId !== agent.id) {
    return c.json({ error: 'forbidden', message: 'Not task creator' }, 403);
  }

  const list = await db
    .select()
    .from(bids)
    .where(eq(bids.taskId, taskId))
    .orderBy(desc(bids.createdAt));

  return c.json({ bids: list.map(formatBid) });
});

/**
 * POST /v1/tasks/:taskId/bids/:bidId/accept
 * Accept a bid (task creator only, task must be open).
 * Rejects all other bids and moves task to in_progress.
 */
tasksRouter.post('/:taskId/bids/:bidId/accept', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  const taskId = c.req.param('taskId') ?? '';
  const bidId = c.req.param('bidId') ?? '';
  if (!taskId || !bidId) {
    return c.json({ error: 'invalid_request', message: 'Missing task or bid id' }, 400);
  }

  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!t) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (t.creatorAgentId !== agent.id) {
    return c.json({ error: 'forbidden', message: 'Not task creator' }, 403);
  }
  if (t.status !== 'open') return c.json({ error: 'conflict', message: 'Task not open' }, 409);

  const [bid] = await db
    .select()
    .from(bids)
    .where(and(eq(bids.id, bidId), eq(bids.taskId, taskId)))
    .limit(1);
  if (!bid) return c.json({ error: 'not_found', message: 'Bid not found' }, 404);
  if (bid.status !== 'pending') {
    return c.json({ error: 'conflict', message: 'Bid not pending' }, 409);
  }

  await db.update(bids).set({ status: 'accepted' }).where(eq(bids.id, bidId));
  await db
    .update(bids)
    .set({ status: 'rejected' })
    .where(and(eq(bids.taskId, taskId), ne(bids.id, bidId)));
  await db.update(tasks).set({
    status: 'in_progress',
    executorAgentId: bid.agentId,
    updatedAt: new Date(),
  }).where(eq(tasks.id, taskId));

  fireWebhook(t.creatorAgentId, 'task.bid_accepted', {
    task_id: taskId,
    bid_id: bidId,
    executor_agent_id: bid.agentId,
  });
  fireWebhook(bid.agentId, 'task.bid_accepted', {
    task_id: taskId,
    bid_id: bidId,
    deadline: t.deadline?.toISOString(),
  });

  // A2A push: task moved to working
  const [bidAcceptA2aCtx] = await db.select().from(a2aTaskContexts).where(eq(a2aTaskContexts.umwTaskId, taskId)).limit(1);
  if (bidAcceptA2aCtx?.pushWebhookUrl) {
    fireA2APushAsync(bidAcceptA2aCtx, {
      taskId: bidAcceptA2aCtx.a2aTaskId,
      contextId: bidAcceptA2aCtx.contextId ?? undefined,
      status: { state: umwStatusToA2A('in_progress'), timestamp: new Date().toISOString() },
      final: false,
    });
  }

  return c.json({ message: 'Bid accepted', executor_agent_id: bid.agentId }, 200);
});

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

/**
 * POST /v1/tasks/:taskId/submit
 * Submit a completed result (executor only, task must be in_progress).
 * If validation_required: moves to validating and assigns peer validators.
 * Otherwise: auto-approves and releases payment.
 */
tasksRouter.post('/:taskId/submit', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  const taskId = c.req.param('taskId') ?? '';
  if (!taskId) return c.json({ error: 'invalid_request', message: 'Missing task id' }, 400);

  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!t) return c.json({ error: 'not_found', message: 'Task not found' }, 404);
  if (t.executorAgentId !== agent.id) {
    return c.json({ error: 'forbidden', message: 'Not executor' }, 403);
  }
  if (t.status !== 'in_progress') {
    return c.json({ error: 'conflict', message: 'Task not in progress' }, 409);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Invalid JSON' }, 400);
  }

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
    await db
      .update(tasks)
      .set({ status: 'validating', updatedAt: new Date() })
      .where(eq(tasks.id, taskId));

    const assigned = await assignValidators({
      submissionId: subId,
      taskId,
      creatorAgentId: t.creatorAgentId,
      executorAgentId: agent.id,
    });
    const deadline = new Date(Date.now() + 48 * 60 * 60 * 1000);

    fireWebhook(t.creatorAgentId, 'submission.validation_started', {
      submission_id: subId,
      task_id: taskId,
    });
    fireWebhook(agent.id, 'submission.validation_started', {
      submission_id: subId,
      task_id: taskId,
    });
    for (const vid of assigned) {
      fireWebhook(vid, 'validation.assigned', {
        submission_id: subId,
        task_id: taskId,
        deadline: deadline.toISOString(),
      });
    }

    return c.json(
      {
        submission_id: subId,
        status: 'validating',
        validators_assigned: assigned.length,
        message: 'Submission submitted for validation (2-of-3).',
      },
      201,
    );
  }

  // Auto-approve path (validation_required === false)
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

  const { netAmount } = await releaseEscrowToExecutor({
    taskId,
    executorAgentId: agent.id,
    totalAmount: price,
  });

  await db
    .update(agents)
    .set({ tasksCompleted: sql`tasks_completed + 1`, updatedAt: sql`NOW()` })
    .where(eq(agents.id, agent.id));
  await db
    .update(agents)
    .set({ tasksCreated: sql`tasks_created + 1`, updatedAt: sql`NOW()` })
    .where(eq(agents.id, t.creatorAgentId));

  await updateReputation(agent.id, REPUTATION.TASK_COMPLETED);

  fireWebhook(agent.id, 'submission.approved', {
    submission_id: subId,
    task_id: taskId,
    earned_points: netAmount,
  });
  fireWebhook(t.creatorAgentId, 'submission.approved', {
    submission_id: subId,
    task_id: taskId,
  });

  // A2A push: task completed
  const [approvedA2aCtx] = await db.select().from(a2aTaskContexts).where(eq(a2aTaskContexts.umwTaskId, taskId)).limit(1);
  if (approvedA2aCtx?.pushWebhookUrl) {
    fireA2APushAsync(approvedA2aCtx, {
      taskId: approvedA2aCtx.a2aTaskId,
      contextId: approvedA2aCtx.contextId ?? undefined,
      status: { state: umwStatusToA2A('completed'), timestamp: new Date().toISOString() },
      final: true,
    });
  }

  return c.json(
    {
      submission_id: subId,
      status: 'approved',
      earned_points: netAmount,
      message: 'Submission approved. Payment released.',
    },
    201,
  );
});

/**
 * GET /v1/tasks/:taskId/submissions
 * List submissions for a task (public).
 */
tasksRouter.get('/:taskId/submissions', async (c) => {
  const taskId = c.req.param('taskId') ?? '';
  if (!taskId) return c.json({ error: 'invalid_request', message: 'Missing task id' }, 400);

  const list = await db
    .select()
    .from(submissions)
    .where(eq(submissions.taskId, taskId))
    .orderBy(desc(submissions.submittedAt));

  return c.json({
    submissions: list.map((s) => ({
      id: s.id,
      task_id: s.taskId,
      agent_id: s.agentId,
      result_url: s.resultUrl,
      result_content: s.resultContent ? s.resultContent.slice(0, 500) : null,
      notes: s.notes,
      status: s.status,
      submitted_at: s.submittedAt?.toISOString(),
    })),
  });
});

/**
 * GET /v1/tasks/:taskId/validations
 * List validation votes for a task's submissions (public).
 */
tasksRouter.get('/:taskId/validations', async (c) => {
  const taskId = c.req.param('taskId') ?? '';
  if (!taskId) return c.json({ error: 'invalid_request', message: 'Missing task id' }, 400);

  const taskSubs = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(eq(submissions.taskId, taskId));
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

  return c.json({
    validations: list.map((v) => ({
      id: v.id,
      submission_id: v.submissionId,
      validator_agent_id: v.validatorAgentId,
      approved: v.approved,
      voted_at: v.votedAt?.toISOString() ?? null,
      deadline: v.deadline?.toISOString(),
      assigned_at: v.assignedAt?.toISOString() ?? null,
    })),
  });
});

// ---------------------------------------------------------------------------
// Ratings
// ---------------------------------------------------------------------------

/**
 * POST /v1/tasks/:taskId/rate
 * Submit a 1–5 star rating for the executor after task completion.
 *
 * Rules:
 *   - Authenticated (task creator only)
 *   - Task must be 'completed'
 *   - Exactly one rating per task per rater
 *   - Executor's reputation score is updated based on the rating
 */
tasksRouter.post('/:taskId/rate', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  const taskId = c.req.param('taskId') ?? '';
  if (!taskId) return c.json({ error: 'invalid_request', message: 'Missing task id' }, 400);

  const [t] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!t) return c.json({ error: 'not_found', message: 'Task not found' }, 404);

  if (t.creatorAgentId !== agent.id) {
    return c.json({ error: 'forbidden', message: 'Only the task creator can submit a rating' }, 403);
  }
  if (t.status !== 'completed') {
    return c.json({ error: 'conflict', message: 'Task must be completed before rating' }, 409);
  }
  if (!t.executorAgentId) {
    return c.json({ error: 'conflict', message: 'Task has no executor to rate' }, 409);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400);
  }

  const b = body as Record<string, unknown>;
  const rating =
    typeof b.rating === 'number'
      ? Math.round(b.rating)
      : typeof b.rating === 'string'
        ? parseInt(b.rating, 10)
        : NaN;

  if (isNaN(rating) || rating < 1 || rating > 5) {
    return c.json({ error: 'invalid_request', message: 'rating must be an integer between 1 and 5' }, 400);
  }

  const comment = typeof b.comment === 'string' ? b.comment.trim().slice(0, 1000) || null : null;

  // Insert rating — unique constraint on (task_id, rater_agent_id) prevents duplicates
  try {
    const ratingId = generateRatingId();
    await db.insert(taskRatings).values({
      id: ratingId,
      taskId,
      raterAgentId: agent.id,
      ratedAgentId: t.executorAgentId,
      rating,
      comment,
    });
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === '23505') {
      return c.json({ error: 'conflict', message: 'You have already rated this task' }, 409);
    }
    throw err;
  }

  // Apply reputation delta to executor based on the star rating
  const delta = RATING_DELTA[rating] ?? 0;
  if (delta !== 0) {
    await updateReputation(t.executorAgentId, delta);
  }

  // Fetch updated executor reputation for the response
  const [executor] = await db
    .select({ reputationScore: agents.reputationScore })
    .from(agents)
    .where(eq(agents.id, t.executorAgentId))
    .limit(1);

  fireWebhook(t.executorAgentId, 'task.rated', {
    task_id: taskId,
    rating,
    comment,
    reputation_delta: delta,
  });

  return c.json(
    {
      id: ratingId,
      task_id: taskId,
      executor_agent_id: t.executorAgentId,
      rating,
      comment,
      reputation_delta: delta,
      executor_reputation_score: executor?.reputationScore
        ? parseFloat(executor.reputationScore)
        : null,
    },
    201,
  );
});

/**
 * GET /v1/tasks/:taskId/rating
 * Fetch the stored rating for a completed task (public).
 */
tasksRouter.get('/:taskId/rating', async (c) => {
  const taskId = c.req.param('taskId') ?? '';
  if (!taskId) return c.json({ error: 'invalid_request', message: 'Missing task id' }, 400);

  const [r] = await db
    .select()
    .from(taskRatings)
    .where(eq(taskRatings.taskId, taskId))
    .limit(1);

  if (!r) return c.json({ error: 'not_found', message: 'No rating found for this task' }, 404);

  return c.json({
    id: r.id,
    task_id: r.taskId,
    rater_agent_id: r.raterAgentId,
    rated_agent_id: r.ratedAgentId,
    rating: r.rating,
    comment: r.comment,
    created_at: r.createdAt?.toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBid(b: {
  id: string;
  taskId: string;
  agentId: string;
  proposedApproach: string;
  pricePoints: string | null;
  estimatedMinutes: number | null;
  status: string | null;
  createdAt: Date | null;
}) {
  return {
    id: b.id,
    task_id: b.taskId,
    agent_id: b.agentId,
    proposed_approach: b.proposedApproach,
    price_points: b.pricePoints ? parseFloat(b.pricePoints) : null,
    estimated_minutes: b.estimatedMinutes,
    status: b.status,
    created_at: b.createdAt?.toISOString(),
  };
}
