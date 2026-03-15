import { eq, and, sql, isNotNull } from 'drizzle-orm';
import { db } from '../db/pool.js';
import { agents, validations, submissions, tasks, a2aTaskContexts } from '../db/schema/index.js';
import { releaseEscrowToExecutor, refundEscrow, systemCredit } from './transfer.js';
import { transferUsdc } from './usdc-transfer.js';
import { generateValidationId } from './ids.js';
import { fireWebhook } from './webhooks.js';
import { updateReputation, REPUTATION } from './reputation.js';
import { notifyA2AStatus } from '../a2a/push.js';
import { umwStatusToA2A } from '../a2a/handler.js';
import type { AgentRow, TaskRow } from '../db/schema/index.js';

// ---------------------------------------------------------------------------
// Auto-approve configuration (configurable via env vars)
// ---------------------------------------------------------------------------
const AUTO_APPROVE_MIN_REPUTATION = parseFloat(process.env.AUTO_APPROVE_MIN_REPUTATION ?? '4.5');
const AUTO_APPROVE_MIN_TASKS      = parseInt(process.env.AUTO_APPROVE_MIN_TASKS ?? '10', 10);
const AUTO_APPROVE_MAX_POINTS     = parseFloat(process.env.AUTO_APPROVE_MAX_POINTS ?? '500');
const AUTO_APPROVE_MAX_USDC       = parseFloat(process.env.AUTO_APPROVE_MAX_USDC ?? '50');

/**
 * Determine whether a submission should be auto-approved based on executor reputation.
 *
 * Auto-approve fires when ALL of the following are true:
 *   - executor.reputation_score >= AUTO_APPROVE_MIN_REPUTATION (default 4.5)
 *   - executor.tasks_completed  >= AUTO_APPROVE_MIN_TASKS      (default 10)
 *   - task.validation_required  === true  (only bypasses when validation was configured)
 *   - For points tasks: price_points <= AUTO_APPROVE_MAX_POINTS (default 500)
 *   - For USDC  tasks: price_usdc   <= AUTO_APPROVE_MAX_USDC   (default 50.00)
 *
 * Returns { approve: true, reason: string } or { approve: false, reason: string }.
 */
export function shouldAutoApprove(
  executor: AgentRow,
  task: Pick<TaskRow, 'validationRequired' | 'paymentMode' | 'pricePoints' | 'priceUsdc'>,
): { approve: boolean; reason: string } {
  const rep       = parseFloat(executor.reputationScore ?? '0');
  const completed = executor.tasksCompleted ?? 0;
  const price     = parseFloat(task.pricePoints ?? '0');
  const priceUsdc = parseFloat(task.priceUsdc ?? '0');

  if (!task.validationRequired) {
    return { approve: false, reason: 'validation_not_required' };
  }
  if (rep < AUTO_APPROVE_MIN_REPUTATION) {
    return { approve: false, reason: `reputation ${rep} < ${AUTO_APPROVE_MIN_REPUTATION}` };
  }
  if (completed < AUTO_APPROVE_MIN_TASKS) {
    return { approve: false, reason: `tasks_completed ${completed} < ${AUTO_APPROVE_MIN_TASKS}` };
  }
  if (task.paymentMode === 'points' && price > AUTO_APPROVE_MAX_POINTS) {
    return { approve: false, reason: `price ${price} > ${AUTO_APPROVE_MAX_POINTS} (points limit)` };
  }
  if (task.paymentMode === 'usdc' && priceUsdc > AUTO_APPROVE_MAX_USDC) {
    return { approve: false, reason: `price_usdc ${priceUsdc} > ${AUTO_APPROVE_MAX_USDC} (USDC limit)` };
  }

  const parts: string[] = [
    `Executor reputation ${rep} >= ${AUTO_APPROVE_MIN_REPUTATION}`,
    `tasks_completed ${completed} >= ${AUTO_APPROVE_MIN_TASKS}`,
  ];
  if (task.paymentMode === 'points') {
    parts.push(`price ${price} <= ${AUTO_APPROVE_MAX_POINTS}`);
  } else {
    parts.push(`price_usdc ${priceUsdc} <= ${AUTO_APPROVE_MAX_USDC}`);
  }
  return { approve: true, reason: parts.join(', ') };
}

const VALIDATION_DEADLINE_HOURS = 48;
const VALIDATOR_REWARD = 5;
const REQUIRED_APPROVALS = 2;
const REQUIRED_REJECTIONS = 2;

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Assign N validators (up to 3) for a submission. Excludes task creator and executor.
 */
export async function assignValidators(opts: {
  submissionId: string;
  taskId: string;
  creatorAgentId: string;
  executorAgentId: string;
}): Promise<string[]> {
  const { submissionId, taskId, creatorAgentId, executorAgentId } = opts;
  const deadline = new Date(Date.now() + VALIDATION_DEADLINE_HOURS * 60 * 60 * 1000);

  const pool = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.status, 'verified'),
        sql`${agents.id} <> ${creatorAgentId}`,
        sql`${agents.id} <> ${executorAgentId}`,
        sql`${agents.id} <> 'agt_system'`
      )
    );

  const shuffled = shuffle(pool.map((r) => r.id));
  const selected = shuffled.slice(0, 3);
  if (selected.length === 0) return [];

  for (const validatorId of selected) {
    await db.insert(validations).values({
      id: generateValidationId(),
      submissionId,
      validatorAgentId: validatorId,
      deadline,
    });
  }
  return selected;
}

/**
 * Check votes for a submission and resolve if 2-of-3 reached (approve or reject).
 * Counts timeouts (approved IS NULL and voted_at set by cron). Auto-approve if 1 approve + 2 timeout.
 */
export async function resolveValidation(submissionId: string): Promise<'resolved' | 'pending'> {
  const rows = await db
    .select({
      approved: validations.approved,
      validatorAgentId: validations.validatorAgentId,
      votedAt: validations.votedAt,
    })
    .from(validations)
    .where(eq(validations.submissionId, submissionId));

  const approvedCount = rows.filter((r) => r.approved === true).length;
  const rejectedCount = rows.filter((r) => r.approved === false).length;
  const timeoutCount = rows.filter((r) => r.approved === null && r.votedAt != null).length;

  if (approvedCount >= REQUIRED_APPROVALS) {
    await applyApproval(submissionId);
    return 'resolved';
  }
  if (rejectedCount >= REQUIRED_REJECTIONS) {
    await applyRejection(submissionId);
    return 'resolved';
  }
  if (approvedCount === 1 && timeoutCount >= 2) {
    await applyApproval(submissionId);
    return 'resolved';
  }
  if (rejectedCount + timeoutCount >= 2 && approvedCount < 2) {
    await applyRejection(submissionId);
    return 'resolved';
  }
  return 'pending';
}

async function applyApproval(submissionId: string): Promise<void> {
  const [sub] = await db.select().from(submissions).where(eq(submissions.id, submissionId)).limit(1);
  if (!sub || sub.status !== 'validating') return;
  const [t] = await db.select().from(tasks).where(eq(tasks.id, sub.taskId)).limit(1);
  if (!t) return;

  await db.update(submissions).set({ status: 'approved' }).where(eq(submissions.id, submissionId));
  await db.update(tasks).set({ status: 'completed', updatedAt: new Date() }).where(eq(tasks.id, sub.taskId));

  if (t.paymentMode === 'usdc') {
    // USDC payout: transfer from platform wallet to executor's evm_address
    const [executor] = await db.select({ evmAddress: agents.evmAddress })
      .from(agents)
      .where(eq(agents.id, sub.agentId))
      .limit(1);

    if (!executor?.evmAddress) {
      // Executor has no EVM address — hold funds, send webhook warning
      console.warn(`[validation] Executor ${sub.agentId} has no evm_address — USDC payout held for task ${sub.taskId}`);
      fireWebhook(sub.agentId, 'payment.held', {
        task_id: sub.taskId,
        submission_id: submissionId,
        reason: 'no_evm_address',
        message: 'Set evm_address via PATCH /v1/agents/me to receive USDC payout',
      });
    } else {
      const priceUsdc = parseFloat(t.priceUsdc ?? '0');
      try {
        await transferUsdc({
          to: executor.evmAddress as `0x${string}`,
          amountUsdc: priceUsdc,
          taskId: sub.taskId,
        });
      } catch (err) {
        console.error(`[validation] USDC transfer failed for task ${sub.taskId}:`, err);
        fireWebhook(sub.agentId, 'payment.failed', {
          task_id: sub.taskId,
          submission_id: submissionId,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }
  } else {
    // Points payout (default)
    const price = parseFloat(t.pricePoints ?? '0');
    await releaseEscrowToExecutor({
      taskId: sub.taskId,
      executorAgentId: sub.agentId,
      totalAmount: price,
    });
  }
  await db.update(agents).set({
    tasksCompleted: sql`tasks_completed + 1`,
    updatedAt: sql`NOW()`,
  }).where(eq(agents.id, sub.agentId));
  await db.update(agents).set({
    tasksCreated: sql`tasks_created + 1`,
    updatedAt: sql`NOW()`,
  }).where(eq(agents.id, t.creatorAgentId));
  await updateReputation(sub.agentId, REPUTATION.TASK_COMPLETED);
  const votedValidators = await db
    .select({ validatorAgentId: validations.validatorAgentId })
    .from(validations)
    .where(and(eq(validations.submissionId, submissionId), sql`${validations.approved} IS NOT NULL`));
  for (const v of votedValidators) {
    await systemCredit({
      toAgentId: v.validatorAgentId,
      amount: VALIDATOR_REWARD,
      type: 'validation_reward',
      memo: `Validation for ${submissionId}`,
    });
    await updateReputation(v.validatorAgentId, REPUTATION.VALIDATOR_GOOD);
  }
  await applyTimeoutPenalties(submissionId);
  fireWebhook(sub.agentId, 'submission.approved', { submission_id: submissionId, task_id: sub.taskId });
  fireWebhook(t.creatorAgentId, 'submission.approved', { submission_id: submissionId, task_id: sub.taskId });

  // A2A notify: task completed via validation (SSE + webhook)
  const [valApprA2aCtx] = await db.select().from(a2aTaskContexts).where(eq(a2aTaskContexts.umwTaskId, sub.taskId)).limit(1);
  if (valApprA2aCtx) {
    notifyA2AStatus(valApprA2aCtx, {
      taskId: valApprA2aCtx.a2aTaskId,
      contextId: valApprA2aCtx.contextId ?? undefined,
      status: { state: umwStatusToA2A('completed'), timestamp: new Date().toISOString() },
      final: true,
    });
  }
}

async function applyRejection(submissionId: string): Promise<void> {
  const [sub] = await db.select().from(submissions).where(eq(submissions.id, submissionId)).limit(1);
  if (!sub || sub.status !== 'validating') return;
  const [t] = await db.select().from(tasks).where(eq(tasks.id, sub.taskId)).limit(1);
  if (!t) return;
  const price = parseFloat(t.pricePoints ?? '0');
  await db.update(submissions).set({ status: 'rejected' }).where(eq(submissions.id, submissionId));
  await db.update(tasks).set({ status: 'open', executorAgentId: null, updatedAt: new Date() }).where(eq(tasks.id, sub.taskId));
  await updateReputation(sub.agentId, REPUTATION.VALIDATION_FAILED);
  await applyTimeoutPenalties(submissionId);
  await refundEscrow({ creatorAgentId: t.creatorAgentId, amount: price, taskId: sub.taskId });
  fireWebhook(sub.agentId, 'submission.rejected', { submission_id: submissionId, task_id: sub.taskId });
  fireWebhook(t.creatorAgentId, 'submission.rejected', { submission_id: submissionId, task_id: sub.taskId });

  // A2A notify: task failed via validation rejection (SSE + webhook)
  const [valRejA2aCtx] = await db.select().from(a2aTaskContexts).where(eq(a2aTaskContexts.umwTaskId, sub.taskId)).limit(1);
  if (valRejA2aCtx) {
    notifyA2AStatus(valRejA2aCtx, {
      taskId: valRejA2aCtx.a2aTaskId,
      contextId: valRejA2aCtx.contextId ?? undefined,
      status: { state: umwStatusToA2A('disputed'), timestamp: new Date().toISOString() },
      final: true,
    });
  }
}

async function applyTimeoutPenalties(submissionId: string): Promise<void> {
  const timeouts = await db
    .select({ validatorAgentId: validations.validatorAgentId })
    .from(validations)
    .where(and(eq(validations.submissionId, submissionId), sql`${validations.approved} IS NULL`, isNotNull(validations.votedAt)));
  for (const r of timeouts) {
    await updateReputation(r.validatorAgentId, REPUTATION.VALIDATOR_TIMEOUT);
  }
}

/**
 * Resolve submissions that are still 'validating' and whose validation deadline has passed.
 * Cron sets voted_at on timed-out validations; this runs resolveValidation so e.g. 0 approve + 3 timeout → reject.
 */
export async function runValidationDeadlineResolution(): Promise<void> {
  const now = new Date();
  const subs = await db.select({ id: submissions.id }).from(submissions).where(eq(submissions.status, 'validating'));
  for (const { id: submissionId } of subs) {
    const vals = await db.select({ deadline: validations.deadline }).from(validations).where(eq(validations.submissionId, submissionId));
    const allExpired = vals.length > 0 && vals.every((v) => v.deadline && v.deadline <= now);
    if (allExpired) await resolveValidation(submissionId);
  }
}
