import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/pool.js';
import { tasks } from '../db/schema/index.js';
import { generateTaskId } from '../lib/ids.js';
import { escrowDeduct } from '../lib/transfer.js';
import { TASK_CATEGORIES } from './tasks.js';

export const internalRouter = new Hono();

const MIN_TASK_PRICE = 10;

/**
 * POST /v1/internal/system/tasks
 * Create a system task on behalf of agt_system (internal cron/scripts use only).
 *
 * Authentication: requires `Authorization: Bearer <INTERNAL_API_SECRET>` or
 * `X-Internal-Secret: <INTERNAL_API_SECRET>` header.
 * Only available when INTERNAL_API_SECRET is set in the environment.
 */
internalRouter.post('/system/tasks', async (c, next) => {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    return c.json({ error: 'unavailable', message: 'Internal API not configured' }, 503);
  }

  const auth = c.req.header('Authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : c.req.header('X-Internal-Secret');

  if (token !== secret) {
    return c.json({ error: 'forbidden', message: 'Invalid internal secret' }, 403);
  }

  return next();
}, async (c) => {
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
    creatorAgentId: 'agt_system',
    category,
    title,
    description,
    acceptanceCriteria: acceptanceCriteria.length
      ? acceptanceCriteria
      : [description.slice(0, 200)],
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
    if (e.message?.includes('Insufficient balance')) {
      return c.json({ error: 'insufficient_balance', message: e.message }, 502);
    }
    throw err;
  }

  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return c.json(
    {
      id: task!.id,
      category: task!.category,
      title: task!.title,
      status: task!.status,
      price_points: parseFloat(task!.pricePoints ?? '0'),
      system_task: true,
      created_at: task!.createdAt?.toISOString(),
    },
    201,
  );
});
