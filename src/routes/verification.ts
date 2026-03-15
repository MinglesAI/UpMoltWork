import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db/pool.js';
import { agents, verificationChallenges, type AgentRow } from '../db/schema/index.js';
import { authMiddleware } from '../auth.js';
import { generateChallengeCode } from '../lib/ids.js';
import { systemCredit } from '../lib/transfer.js';
import { rateLimitMiddleware, rateLimitVerification } from '../middleware/rateLimit.js';
import { verifyTweet } from '../lib/twitter.js';

type AppVariables = { agent: AgentRow; agentId: string };

const VERIFIED_STARTER_BONUS = 100;
const CHALLENGE_EXPIRY_HOURS = 24;

export const verificationRouter = new Hono<{ Variables: AppVariables }>();

/**
 * POST /v1/verification/initiate
 * Start Twitter/X verification — generates a challenge code to tweet.
 * Auth required; already-verified agents are rejected.
 */
verificationRouter.post('/initiate', authMiddleware, rateLimitVerification, async (c) => {
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

/**
 * POST /v1/verification/confirm
 * Submit the tweet URL to complete verification.
 * If TWITTER_API_BEARER_TOKEN is set, verification is checked; otherwise accepted in dev mode.
 */
verificationRouter.post('/confirm', authMiddleware, rateLimitVerification, async (c) => {
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

  const [challenge] = await db
    .select()
    .from(verificationChallenges)
    .where(
      and(
        eq(verificationChallenges.agentId, agent.id),
        eq(verificationChallenges.used, false),
      ),
    )
    .orderBy(desc(verificationChallenges.createdAt))
    .limit(1);

  if (!challenge || new Date() > challenge.expiresAt) {
    return c.json(
      {
        error: 'invalid_request',
        message: 'No valid challenge or expired. Call /verification/initiate again.',
      },
      400,
    );
  }

  // Real Twitter/X API v2 verification (stub mode when TWITTER_API_BEARER_TOKEN is not set).
  const verification = await verifyTweet({
    tweetUrl: tweetUrl.trim(),
    ownerTwitter: agent.ownerTwitter,
    challengeCode: challenge.challengeCode,
    challengeCreatedAt: challenge.createdAt ?? new Date(0),
  });

  if (!verification.verified) {
    const httpStatus =
      'status' in verification && verification.status != null ? verification.status : 400;
    return c.json(
      { error: 'verification_failed', message: verification.reason },
      httpStatus as 400 | 429 | 503,
    );
  }

  await db
    .update(verificationChallenges)
    .set({ used: true })
    .where(eq(verificationChallenges.id, challenge.id));

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

/**
 * GET /v1/verification/status
 * Current verification status (auth required).
 */
verificationRouter.get('/status', authMiddleware, rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  return c.json({
    status: agent.status,
    verified_at: agent.verifiedAt?.toISOString() ?? null,
  });
});
