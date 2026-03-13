import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/pool.js';
import { agents, validations, submissions, tasks } from '../db/schema/index.js';
import { releaseEscrowToExecutor, refundEscrow, systemCredit } from './transfer.js';
import { generateValidationId } from './ids.js';
import { fireWebhook } from './webhooks.js';

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
 * Pays executor or refunds creator; pays validators 5 points each.
 */
export async function resolveValidation(submissionId: string): Promise<'resolved' | 'pending'> {
  const rows = await db
    .select({ approved: validations.approved, validatorAgentId: validations.validatorAgentId })
    .from(validations)
    .where(eq(validations.submissionId, submissionId));

  const voted = rows.filter((r) => r.approved !== null);
  const approved = voted.filter((r) => r.approved === true).length;
  const rejected = voted.filter((r) => r.approved === false).length;

  if (approved >= REQUIRED_APPROVALS) {
    await applyApproval(submissionId);
    return 'resolved';
  }
  if (rejected >= REQUIRED_REJECTIONS) {
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
  const price = parseFloat(t.pricePoints ?? '0');
  await db.update(submissions).set({ status: 'approved' }).where(eq(submissions.id, submissionId));
  await db.update(tasks).set({ status: 'completed', updatedAt: new Date() }).where(eq(tasks.id, sub.taskId));
  await releaseEscrowToExecutor({
    taskId: sub.taskId,
    executorAgentId: sub.agentId,
    totalAmount: price,
  });
  await db.update(agents).set({
    tasksCompleted: sql`tasks_completed + 1`,
    updatedAt: sql`NOW()`,
  }).where(eq(agents.id, sub.agentId));
  await db.update(agents).set({
    tasksCreated: sql`tasks_created + 1`,
    updatedAt: sql`NOW()`,
  }).where(eq(agents.id, t.creatorAgentId));
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
  }
  fireWebhook(sub.agentId, 'submission.approved', { submission_id: submissionId, task_id: sub.taskId });
  fireWebhook(t.creatorAgentId, 'submission.approved', { submission_id: submissionId, task_id: sub.taskId });
}

async function applyRejection(submissionId: string): Promise<void> {
  const [sub] = await db.select().from(submissions).where(eq(submissions.id, submissionId)).limit(1);
  if (!sub || sub.status !== 'validating') return;
  const [t] = await db.select().from(tasks).where(eq(tasks.id, sub.taskId)).limit(1);
  if (!t) return;
  const price = parseFloat(t.pricePoints ?? '0');
  await db.update(submissions).set({ status: 'rejected' }).where(eq(submissions.id, submissionId));
  await db.update(tasks).set({ status: 'open', executorAgentId: null, updatedAt: new Date() }).where(eq(tasks.id, sub.taskId));
  await refundEscrow({ creatorAgentId: t.creatorAgentId, amount: price, taskId: sub.taskId });
  fireWebhook(sub.agentId, 'submission.rejected', { submission_id: submissionId, task_id: sub.taskId });
  fireWebhook(t.creatorAgentId, 'submission.rejected', { submission_id: submissionId, task_id: sub.taskId });
}
