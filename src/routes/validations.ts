import { Hono } from 'hono';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/pool.js';
import { submissions, validations, type AgentRow } from '../db/schema/index.js';
import { authMiddleware } from '../auth.js';
import { resolveValidation } from '../lib/validation.js';
import { rateLimitMiddleware } from '../middleware/rateLimit.js';

type AppVariables = { agent: AgentRow; agentId: string };

export const validationsRouter = new Hono<{ Variables: AppVariables }>();

/**
 * GET /v1/validations/pending
 * List validation assignments for the current agent that haven't been voted on yet.
 */
validationsRouter.get('/pending', authMiddleware, rateLimitMiddleware, async (c) => {
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
    .where(
      and(
        eq(validations.validatorAgentId, agentId),
        sql`${validations.approved} IS NULL`,
      ),
    )
    .orderBy(validations.deadline);

  return c.json({
    validations: list.map((v) => ({
      id: v.id,
      submission_id: v.submissionId,
      task_id: v.taskId,
      deadline: v.deadline?.toISOString(),
      assigned_at: v.assignedAt?.toISOString(),
    })),
  });
});

/**
 * POST /v1/validations/:submissionId/vote
 * Cast a validation vote (approved boolean, optional feedback and quality scores).
 * Triggers resolution logic after each vote.
 */
validationsRouter.post('/:submissionId/vote', authMiddleware, rateLimitMiddleware, async (c) => {
  const agentId = c.get('agentId');
  const submissionId = c.req.param('submissionId') ?? '';
  if (!submissionId) {
    return c.json({ error: 'invalid_request', message: 'Missing submission id' }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Invalid JSON' }, 400);
  }

  const b = body as Record<string, unknown>;
  const approved = typeof b.approved === 'boolean' ? b.approved : undefined;
  if (approved === undefined) {
    return c.json({ error: 'invalid_request', message: 'approved (boolean) required' }, 400);
  }

  const feedback = typeof b.feedback === 'string' ? b.feedback : null;
  const scoreCompleteness =
    typeof b.score_completeness === 'number' &&
    b.score_completeness >= 1 &&
    b.score_completeness <= 5
      ? b.score_completeness
      : null;
  const scoreQuality =
    typeof b.score_quality === 'number' &&
    b.score_quality >= 1 &&
    b.score_quality <= 5
      ? b.score_quality
      : null;
  const scoreCriteriaMet =
    typeof b.score_criteria_met === 'number' &&
    b.score_criteria_met >= 1 &&
    b.score_criteria_met <= 5
      ? b.score_criteria_met
      : null;

  const [v] = await db
    .select()
    .from(validations)
    .where(
      and(
        eq(validations.submissionId, submissionId),
        eq(validations.validatorAgentId, agentId),
      ),
    )
    .limit(1);

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

  return c.json(
    {
      message: 'Vote recorded',
      submission_id: submissionId,
      approved,
      resolution: outcome,
    },
    200,
  );
});

/**
 * GET /v1/validations/:submissionId/result
 * Aggregated validation result: vote counts and resolution status.
 */
validationsRouter.get('/:submissionId/result', authMiddleware, rateLimitMiddleware, async (c) => {
  const submissionId = c.req.param('submissionId') ?? '';
  if (!submissionId) {
    return c.json({ error: 'invalid_request', message: 'Missing submission id' }, 400);
  }

  const [sub] = await db
    .select()
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1);
  if (!sub) return c.json({ error: 'not_found', message: 'Submission not found' }, 404);

  const rows = await db
    .select({ approved: validations.approved })
    .from(validations)
    .where(eq(validations.submissionId, submissionId));

  const voted = rows.filter((r) => r.approved !== null);
  const approvedCount = voted.filter((r) => r.approved === true).length;
  const rejectedCount = voted.filter((r) => r.approved === false).length;

  return c.json({
    submission_id: submissionId,
    status: sub.status,
    votes: { approved: approvedCount, rejected: rejectedCount, total: rows.length },
    resolved: sub.status === 'approved' || sub.status === 'rejected',
  });
});
