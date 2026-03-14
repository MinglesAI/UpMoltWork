/**
 * Recurring Tasks Admin Routes
 *
 * All routes are admin-only. Mount under /v1/admin/recurring-templates in src/index.ts.
 * Auth middleware is applied at the adminRouter level already.
 */

import { Hono } from 'hono';
import { eq, desc, count, sql } from 'drizzle-orm';
import { db } from '../db/pool.js';
import { recurringTaskTemplates, recurringTaskInstances } from '../db/schema/recurringTasks.js';
import { tasks } from '../db/schema/index.js';
import { generateRecurringTemplateId } from '../lib/ids.js';
import { triggerTemplateNow } from '../services/recurringScheduler.js';

export const recurringTasksAdminRouter = new Hono();

// ─── Auth middleware (same as adminRouter) ────────────────────────────────────

recurringTasksAdminRouter.use('*', async (c, next) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    return c.json({ error: 'unavailable', message: 'Admin API not configured — set ADMIN_SECRET' }, 503);
  }
  const auth = c.req.header('Authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token || token !== secret) {
    return c.json({ error: 'forbidden', message: 'Invalid or missing admin token' }, 403);
  }
  await next();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parsePagination(query: Record<string, string>) {
  const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? '50', 10) || 50));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

const VALID_MODES = ['infinite', 'periodic', 'capped'] as const;
const VALID_VALIDATION_TYPES = ['peer', 'auto', 'link', 'code', 'combined'] as const;

// ─── GET /v1/admin/recurring-templates ───────────────────────────────────────

recurringTasksAdminRouter.get('/', async (c) => {
  const query = c.req.query() as Record<string, string>;
  const { page, limit, offset } = parsePagination(query);

  const [rows, totalResult] = await Promise.all([
    db
      .select({
        id: recurringTaskTemplates.id,
        title_template: recurringTaskTemplates.titleTemplate,
        description_template: recurringTaskTemplates.descriptionTemplate,
        category: recurringTaskTemplates.category,
        price_points: recurringTaskTemplates.pricePoints,
        mode: recurringTaskTemplates.mode,
        max_concurrent: recurringTaskTemplates.maxConcurrent,
        max_total: recurringTaskTemplates.maxTotal,
        completed_count: recurringTaskTemplates.completedCount,
        cron_expr: recurringTaskTemplates.cronExpr,
        timezone: recurringTaskTemplates.timezone,
        validation_type: recurringTaskTemplates.validationType,
        validation_config: recurringTaskTemplates.validationConfig,
        enabled: recurringTaskTemplates.enabled,
        pause_until: recurringTaskTemplates.pauseUntil,
        poster_agent_id: recurringTaskTemplates.posterAgentId,
        metadata: recurringTaskTemplates.metadata,
        created_at: recurringTaskTemplates.createdAt,
        updated_at: recurringTaskTemplates.updatedAt,
        // Count of open instances
        open_instances: sql<number>`(
          SELECT count(*)::int FROM recurring_task_instances rti
          INNER JOIN tasks t ON t.id = rti.task_id
          WHERE rti.template_id = recurring_task_templates.id
            AND t.status IN ('open', 'bidding', 'in_progress', 'submitted', 'validating')
        )`,
      })
      .from(recurringTaskTemplates)
      .orderBy(desc(recurringTaskTemplates.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(recurringTaskTemplates),
  ]);

  return c.json({
    data: rows.map(r => ({
      ...r,
      pause_until: r.pause_until?.toISOString() ?? null,
      created_at: r.created_at?.toISOString(),
      updated_at: r.updated_at?.toISOString(),
    })),
    pagination: { page, limit, total: totalResult[0]?.total ?? 0 },
  });
});

// ─── POST /v1/admin/recurring-templates ──────────────────────────────────────

recurringTasksAdminRouter.post('/', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400);
  }

  const b = body as Record<string, unknown>;

  const titleTemplate = typeof b.title_template === 'string' ? b.title_template.trim() : '';
  const descriptionTemplate = typeof b.description_template === 'string' ? b.description_template.trim() : '';
  const category = typeof b.category === 'string' ? b.category.trim() : '';
  const pricePoints = typeof b.price_points === 'number' ? b.price_points : parseInt(String(b.price_points ?? '15'), 10);

  if (!titleTemplate) return c.json({ error: 'invalid_request', message: 'title_template required' }, 400);
  if (!descriptionTemplate) return c.json({ error: 'invalid_request', message: 'description_template required' }, 400);
  if (!category) return c.json({ error: 'invalid_request', message: 'category required' }, 400);
  if (isNaN(pricePoints) || pricePoints < 1) return c.json({ error: 'invalid_request', message: 'price_points must be a positive integer' }, 400);

  const mode = (typeof b.mode === 'string' ? b.mode : 'periodic') as typeof VALID_MODES[number];
  if (!VALID_MODES.includes(mode)) {
    return c.json({ error: 'invalid_request', message: `mode must be one of: ${VALID_MODES.join(', ')}` }, 400);
  }

  const validationType = (typeof b.validation_type === 'string' ? b.validation_type : 'peer') as typeof VALID_VALIDATION_TYPES[number];
  if (!VALID_VALIDATION_TYPES.includes(validationType)) {
    return c.json({ error: 'invalid_request', message: `validation_type must be one of: ${VALID_VALIDATION_TYPES.join(', ')}` }, 400);
  }

  const maxConcurrent = typeof b.max_concurrent === 'number' ? b.max_concurrent : 1;
  const maxTotal = typeof b.max_total === 'number' ? b.max_total : null;
  const cronExpr = typeof b.cron_expr === 'string' ? b.cron_expr.trim() : null;
  const timezone = typeof b.timezone === 'string' ? b.timezone.trim() : 'UTC';
  const posterAgentId = typeof b.poster_agent_id === 'string' ? b.poster_agent_id.trim() : null;
  const enabled = typeof b.enabled === 'boolean' ? b.enabled : true;
  const validationConfig = b.validation_config ?? null;
  const metadata = b.metadata ?? null;

  const id = generateRecurringTemplateId();

  const [row] = await db
    .insert(recurringTaskTemplates)
    .values({
      id,
      titleTemplate,
      descriptionTemplate,
      category,
      pricePoints,
      mode,
      maxConcurrent,
      maxTotal: maxTotal ?? undefined,
      cronExpr: cronExpr ?? undefined,
      timezone,
      validationType,
      validationConfig,
      enabled,
      posterAgentId: posterAgentId ?? undefined,
      metadata,
    })
    .returning();

  return c.json({ data: { ...row, created_at: row.createdAt?.toISOString(), updated_at: row.updatedAt?.toISOString() } }, 201);
});

// ─── PATCH /v1/admin/recurring-templates/:id ─────────────────────────────────

recurringTasksAdminRouter.patch('/:id', async (c) => {
  const { id } = c.req.param();

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400);
  }

  const b = body as Record<string, unknown>;
  const updates: Partial<typeof recurringTaskTemplates.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (typeof b.title_template === 'string') updates.titleTemplate = b.title_template.trim();
  if (typeof b.description_template === 'string') updates.descriptionTemplate = b.description_template.trim();
  if (typeof b.category === 'string') updates.category = b.category.trim();
  if (typeof b.price_points === 'number') updates.pricePoints = b.price_points;
  if (typeof b.mode === 'string') {
    if (!VALID_MODES.includes(b.mode as typeof VALID_MODES[number])) {
      return c.json({ error: 'invalid_request', message: `mode must be one of: ${VALID_MODES.join(', ')}` }, 400);
    }
    updates.mode = b.mode;
  }
  if (typeof b.max_concurrent === 'number') updates.maxConcurrent = b.max_concurrent;
  if (b.max_total !== undefined) updates.maxTotal = typeof b.max_total === 'number' ? b.max_total : undefined;
  if (typeof b.cron_expr === 'string') updates.cronExpr = b.cron_expr.trim() || undefined;
  if (typeof b.timezone === 'string') updates.timezone = b.timezone.trim();
  if (typeof b.validation_type === 'string') {
    if (!VALID_VALIDATION_TYPES.includes(b.validation_type as typeof VALID_VALIDATION_TYPES[number])) {
      return c.json({ error: 'invalid_request', message: `validation_type must be one of: ${VALID_VALIDATION_TYPES.join(', ')}` }, 400);
    }
    updates.validationType = b.validation_type;
  }
  if (b.validation_config !== undefined) updates.validationConfig = b.validation_config;
  if (typeof b.enabled === 'boolean') updates.enabled = b.enabled;
  if (b.pause_until !== undefined) {
    updates.pauseUntil = b.pause_until ? new Date(b.pause_until as string) : undefined;
  }
  if (typeof b.poster_agent_id === 'string') updates.posterAgentId = b.poster_agent_id.trim();
  if (b.metadata !== undefined) updates.metadata = b.metadata;

  const rows = await db
    .update(recurringTaskTemplates)
    .set(updates)
    .where(eq(recurringTaskTemplates.id, id))
    .returning();

  if (rows.length === 0) {
    return c.json({ error: 'not_found', message: `Template ${id} not found` }, 404);
  }

  const row = rows[0];
  return c.json({
    data: {
      ...row,
      pause_until: row.pauseUntil?.toISOString() ?? null,
      created_at: row.createdAt?.toISOString(),
      updated_at: row.updatedAt?.toISOString(),
    },
  });
});

// ─── DELETE /v1/admin/recurring-templates/:id ────────────────────────────────

recurringTasksAdminRouter.delete('/:id', async (c) => {
  const { id } = c.req.param();

  // Soft delete: disable the template
  const rows = await db
    .update(recurringTaskTemplates)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(recurringTaskTemplates.id, id))
    .returning({ id: recurringTaskTemplates.id });

  if (rows.length === 0) {
    return c.json({ error: 'not_found', message: `Template ${id} not found` }, 404);
  }

  return c.json({ data: { id, deleted: true } });
});

// ─── POST /v1/admin/recurring-templates/:id/trigger ──────────────────────────

recurringTasksAdminRouter.post('/:id/trigger', async (c) => {
  const { id } = c.req.param();

  try {
    const taskId = await triggerTemplateNow(id);
    return c.json({ data: { template_id: id, task_id: taskId, triggered_at: new Date().toISOString() } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found')) {
      return c.json({ error: 'not_found', message: msg }, 404);
    }
    return c.json({ error: 'trigger_failed', message: msg }, 500);
  }
});

// ─── GET /v1/admin/recurring-templates/:id/instances ─────────────────────────

recurringTasksAdminRouter.get('/:id/instances', async (c) => {
  const { id } = c.req.param();
  const query = c.req.query() as Record<string, string>;
  const { page, limit, offset } = parsePagination(query);

  const [rows, totalResult] = await Promise.all([
    db
      .select({
        id: recurringTaskInstances.id,
        template_id: recurringTaskInstances.templateId,
        task_id: recurringTaskInstances.taskId,
        posted_at: recurringTaskInstances.postedAt,
        variables: recurringTaskInstances.variables,
        task_status: tasks.status,
        task_title: tasks.title,
      })
      .from(recurringTaskInstances)
      .leftJoin(tasks, eq(tasks.id, recurringTaskInstances.taskId))
      .where(eq(recurringTaskInstances.templateId, id))
      .orderBy(desc(recurringTaskInstances.postedAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: count() })
      .from(recurringTaskInstances)
      .where(eq(recurringTaskInstances.templateId, id)),
  ]);

  if (rows.length === 0 && page === 1) {
    // Check if template exists at all
    const tRows = await db
      .select({ id: recurringTaskTemplates.id })
      .from(recurringTaskTemplates)
      .where(eq(recurringTaskTemplates.id, id))
      .limit(1);

    if (tRows.length === 0) {
      return c.json({ error: 'not_found', message: `Template ${id} not found` }, 404);
    }
  }

  return c.json({
    data: rows.map(r => ({
      ...r,
      posted_at: r.posted_at?.toISOString(),
    })),
    pagination: { page, limit, total: totalResult[0]?.total ?? 0 },
  });
});
