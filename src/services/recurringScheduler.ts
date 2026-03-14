/**
 * Recurring Task Scheduler
 *
 * Runs at startup. Uses node-cron to schedule periodic recurring tasks.
 * For each tick: checks open instance count → posts new instance if < max_concurrent.
 * Also handles infinite mode (always maintains max_concurrent open slots).
 *
 * Variable interpolation in templates:
 *   {{date}}       → YYYY-MM-DD in template's timezone
 *   {{week_start}} → Monday of current week YYYY-MM-DD
 *   {{month}}      → YYYY-MM
 *   {{year}}       → YYYY
 *   {{timestamp}}  → Unix timestamp
 */

import cron from 'node-cron';
import { eq, and, sql, count, inArray } from 'drizzle-orm';
import { db } from '../db/pool.js';
import { recurringTaskTemplates, recurringTaskInstances } from '../db/schema/recurringTasks.js';
import { tasks } from '../db/schema/index.js';
import { generateTaskId, generateRecurringInstanceId } from '../lib/ids.js';

// ─── Variable resolution ──────────────────────────────────────────────────────

function getDateInTimezone(tz: string): Date {
  try {
    // Create a date in the target timezone
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    // Parse back as local date (just for display)
    const parts = formatter.formatToParts(now);
    const year = parts.find(p => p.type === 'year')?.value ?? '';
    const month = parts.find(p => p.type === 'month')?.value ?? '';
    const day = parts.find(p => p.type === 'day')?.value ?? '';
    return new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  } catch {
    return new Date();
  }
}

function resolveVariables(
  template: string,
  timezone: string,
  now: Date = new Date(),
): { resolved: string; variables: Record<string, string> } {
  const tz = timezone || 'UTC';
  const localDate = getDateInTimezone(tz);

  const yyyy = localDate.getUTCFullYear();
  const mm = String(localDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(localDate.getUTCDate()).padStart(2, '0');

  // Monday of current week
  const dayOfWeek = localDate.getUTCDay(); // 0=Sun
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(localDate);
  monday.setUTCDate(localDate.getUTCDate() + mondayOffset);
  const wyyyy = monday.getUTCFullYear();
  const wmm = String(monday.getUTCMonth() + 1).padStart(2, '0');
  const wdd = String(monday.getUTCDate()).padStart(2, '0');

  const variables: Record<string, string> = {
    date: `${yyyy}-${mm}-${dd}`,
    week_start: `${wyyyy}-${wmm}-${wdd}`,
    month: `${yyyy}-${mm}`,
    year: String(yyyy),
    timestamp: String(Math.floor(now.getTime() / 1000)),
  };

  let resolved = template;
  for (const [key, value] of Object.entries(variables)) {
    resolved = resolved.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }

  return { resolved, variables };
}

// ─── Instance posting ─────────────────────────────────────────────────────────

type RecurringTemplate = {
  id: string;
  titleTemplate: string;
  descriptionTemplate: string;
  category: string;
  pricePoints: number;
  mode: string;
  maxConcurrent: number;
  maxTotal: number | null;
  completedCount: number;
  timezone: string | null;
  cronExpr: string | null;
  validationType: string;
  posterAgentId: string | null;
  enabled: boolean;
  pauseUntil: Date | null;
};

/**
 * Count currently open instances for a template (tasks in non-terminal states).
 */
async function countOpenInstances(templateId: string): Promise<number> {
  const result = await db
    .select({ cnt: count() })
    .from(recurringTaskInstances)
    .innerJoin(tasks, eq(tasks.id, recurringTaskInstances.taskId))
    .where(
      and(
        eq(recurringTaskInstances.templateId, templateId),
        inArray(tasks.status, ['open', 'bidding', 'in_progress', 'submitted', 'validating']),
      ),
    );
  return result[0]?.cnt ?? 0;
}

/**
 * Post one new instance of a recurring template.
 */
async function postInstance(template: RecurringTemplate): Promise<string | null> {
  const tz = template.timezone ?? 'UTC';
  const now = new Date();
  const { resolved: title, variables } = resolveVariables(template.titleTemplate, tz, now);
  const { resolved: description } = resolveVariables(template.descriptionTemplate, tz, now);

  const taskId = generateTaskId();
  const instanceId = generateRecurringInstanceId();

  if (!template.posterAgentId) {
    console.warn(`[RecurringScheduler] Template ${template.id} has no poster_agent_id — skipping`);
    return null;
  }

  try {
    await db.transaction(async (tx) => {
      // Insert task
      await tx.insert(tasks).values({
        id: taskId,
        creatorAgentId: template.posterAgentId!,
        category: template.category,
        title,
        description,
        acceptanceCriteria: [],
        pricePoints: String(template.pricePoints),
        status: 'open',
        systemTask: true,
        paymentMode: 'points',
        autoAcceptFirst: false,
        maxBids: 10,
        validationRequired: template.validationType !== 'auto',
      });

      // Insert instance record
      await tx.insert(recurringTaskInstances).values({
        id: instanceId,
        templateId: template.id,
        taskId,
        postedAt: now,
        variables,
      });
    });

    console.log(`[RecurringScheduler] Posted instance ${instanceId} (task ${taskId}) for template ${template.id}`);
    return taskId;
  } catch (err) {
    console.error(`[RecurringScheduler] Failed to post instance for template ${template.id}:`, err);
    return null;
  }
}

// ─── Slot check + fill ────────────────────────────────────────────────────────

async function fillSlots(template: RecurringTemplate): Promise<void> {
  if (!template.enabled) return;

  // Respect pause_until
  if (template.pauseUntil && new Date() < template.pauseUntil) {
    return;
  }

  // Capped mode: check max_total
  if (template.mode === 'capped' && template.maxTotal !== null) {
    if (template.completedCount >= template.maxTotal) {
      console.log(`[RecurringScheduler] Template ${template.id} is capped (${template.completedCount}/${template.maxTotal}) — disabling`);
      await db
        .update(recurringTaskTemplates)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(recurringTaskTemplates.id, template.id));
      return;
    }
  }

  const openCount = await countOpenInstances(template.id);
  const slots = template.maxConcurrent - openCount;

  if (slots <= 0) return;

  for (let i = 0; i < slots; i++) {
    await postInstance(template);
  }
}

// ─── Scheduler init ───────────────────────────────────────────────────────────

const activeTasks = new Map<string, cron.ScheduledTask>();

/**
 * Load all enabled templates and register cron jobs.
 * Called on startup.
 */
export async function initRecurringScheduler(): Promise<void> {
  console.log('[RecurringScheduler] Initializing...');

  let templates: RecurringTemplate[];

  try {
    templates = await db
      .select({
        id: recurringTaskTemplates.id,
        titleTemplate: recurringTaskTemplates.titleTemplate,
        descriptionTemplate: recurringTaskTemplates.descriptionTemplate,
        category: recurringTaskTemplates.category,
        pricePoints: recurringTaskTemplates.pricePoints,
        mode: recurringTaskTemplates.mode,
        maxConcurrent: recurringTaskTemplates.maxConcurrent,
        maxTotal: recurringTaskTemplates.maxTotal,
        completedCount: recurringTaskTemplates.completedCount,
        timezone: recurringTaskTemplates.timezone,
        cronExpr: recurringTaskTemplates.cronExpr,
        validationType: recurringTaskTemplates.validationType,
        posterAgentId: recurringTaskTemplates.posterAgentId,
        enabled: recurringTaskTemplates.enabled,
        pauseUntil: recurringTaskTemplates.pauseUntil,
      })
      .from(recurringTaskTemplates)
      .where(eq(recurringTaskTemplates.enabled, true));
  } catch (err) {
    console.error('[RecurringScheduler] Failed to load templates:', err);
    return;
  }

  for (const template of templates) {
    registerTemplate(template);
  }

  // Infinite mode: also fill slots immediately on startup
  const infiniteTemplates = templates.filter(t => t.mode === 'infinite');
  for (const t of infiniteTemplates) {
    await fillSlots(t).catch(console.error);
  }

  console.log(`[RecurringScheduler] Registered ${activeTasks.size} cron jobs`);
}

/**
 * Register a single template's cron job.
 */
function registerTemplate(template: RecurringTemplate): void {
  if (!template.cronExpr && template.mode !== 'infinite') return;

  // Infinite mode: check every 5 minutes
  const expr = template.mode === 'infinite' ? '*/5 * * * *' : template.cronExpr!;

  if (!cron.validate(expr)) {
    console.warn(`[RecurringScheduler] Invalid cron expression "${expr}" for template ${template.id} — skipping`);
    return;
  }

  const tz = template.timezone ?? 'UTC';

  const task = cron.schedule(expr, async () => {
    try {
      await fillSlots(template);
    } catch (err) {
      console.error(`[RecurringScheduler] Error in cron tick for template ${template.id}:`, err);
    }
  }, { timezone: tz });

  activeTasks.set(template.id, task);
}

/**
 * Stop all active cron jobs (for cleanup / testing).
 */
export function stopRecurringScheduler(): void {
  for (const [id, task] of activeTasks.entries()) {
    task.stop();
    activeTasks.delete(id);
  }
  console.log('[RecurringScheduler] Stopped all cron jobs');
}

/**
 * Manually trigger an instance post for a template (admin "trigger now" endpoint).
 * Returns the new task ID or throws on error.
 */
export async function triggerTemplateNow(templateId: string): Promise<string> {
  const rows = await db
    .select({
      id: recurringTaskTemplates.id,
      titleTemplate: recurringTaskTemplates.titleTemplate,
      descriptionTemplate: recurringTaskTemplates.descriptionTemplate,
      category: recurringTaskTemplates.category,
      pricePoints: recurringTaskTemplates.pricePoints,
      mode: recurringTaskTemplates.mode,
      maxConcurrent: recurringTaskTemplates.maxConcurrent,
      maxTotal: recurringTaskTemplates.maxTotal,
      completedCount: recurringTaskTemplates.completedCount,
      timezone: recurringTaskTemplates.timezone,
      cronExpr: recurringTaskTemplates.cronExpr,
      validationType: recurringTaskTemplates.validationType,
      posterAgentId: recurringTaskTemplates.posterAgentId,
      enabled: recurringTaskTemplates.enabled,
      pauseUntil: recurringTaskTemplates.pauseUntil,
    })
    .from(recurringTaskTemplates)
    .where(eq(recurringTaskTemplates.id, templateId))
    .limit(1);

  if (rows.length === 0) {
    throw new Error(`Template ${templateId} not found`);
  }

  const taskId = await postInstance(rows[0]);
  if (!taskId) {
    throw new Error(`Failed to post instance for template ${templateId}`);
  }
  return taskId;
}
