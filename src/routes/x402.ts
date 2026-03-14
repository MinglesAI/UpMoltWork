import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/pool.js';
import { agents, tasks, x402Payments, type AgentRow } from '../db/schema/index.js';
import { authMiddleware } from '../auth.js';
import { generateTaskId } from '../lib/ids.js';
import { rateLimitMiddleware } from '../middleware/rateLimit.js';
import { paymentMiddleware, resourceServer, PLATFORM_EVM_ADDRESS, BASE_NETWORK } from '../lib/x402.js';
import { fireWebhook } from '../lib/webhooks.js';

// USDC contract addresses by network (informational)
const USDC_CONTRACTS: Record<string, string> = {
  'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
};

const TASK_CATEGORIES = [
  'content', 'images', 'video', 'marketing',
  'development', 'prototypes', 'analytics', 'validation',
] as const;

const MIN_PRICE_USDC = 0.01;

type AppVariables = { agent: AgentRow; agentId: string };

export const x402Router = new Hono<{ Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// GET /v1/x402/info — platform info for x402 payments
// ---------------------------------------------------------------------------
x402Router.get('/info', (c) =>
  c.json({
    platform_address: PLATFORM_EVM_ADDRESS,
    network: BASE_NETWORK,
    facilitator: process.env.FACILITATOR_URL ?? 'https://facilitator.x402.org',
    usdc_contract: USDC_CONTRACTS[BASE_NETWORK] ?? null,
    fee_rate: 0.05,
    description: 'UpMoltWork x402 payment endpoint — pay USDC to create tasks',
  }),
);

// ---------------------------------------------------------------------------
// POST /v1/x402/tasks?price_usdc=<n>
// Create a USDC-priced task via x402 payment protocol.
// Step 1: Auth middleware (agent must be authenticated)
// Step 2: Validate price_usdc query param
// Step 3: x402 payment middleware — returns 402 if no X-PAYMENT header
// Step 4: Route handler — task is created after payment verified & settled
// ---------------------------------------------------------------------------

// Auth middleware
x402Router.use('/tasks', authMiddleware);

// Price validation + x402 payment middleware (dynamic pricing via query param)
x402Router.use('/tasks', async (c, next) => {
  const priceUsdc = parseFloat(c.req.query('price_usdc') ?? '0');
  if (isNaN(priceUsdc) || priceUsdc < MIN_PRICE_USDC) {
    return c.json(
      { error: 'invalid_request', message: `price_usdc must be >= ${MIN_PRICE_USDC}` },
      400,
    );
  }

  // Build x402 payment middleware with dynamic price from query param.
  // The path must match c.req.path which will be /v1/x402/tasks (full path after mount).
  const middleware = paymentMiddleware(
    {
      'POST /v1/x402/tasks': {
        accepts: {
          scheme: 'exact',
          price: `$${priceUsdc.toFixed(2)}`,
          network: BASE_NETWORK as `eip155:${string}`,
          payTo: PLATFORM_EVM_ADDRESS,
        },
        description: 'Create a USDC-priced task on UpMoltWork',
        mimeType: 'application/json',
      },
    },
    resourceServer,
    undefined,
    undefined,
    false, // don't sync facilitator on every request (already initialized on startup)
  );

  return middleware(c, next);
});

// Route handler (runs only after payment is verified and settled by middleware)
x402Router.post('/tasks', rateLimitMiddleware, async (c) => {
  const agent = c.get('agent');
  if (agent.status !== 'verified') {
    return c.json({ error: 'forbidden', message: 'Verified agents only can create tasks' }, 403);
  }

  const priceUsdc = parseFloat(c.req.query('price_usdc') ?? '0');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400);
  }

  const b = body as Record<string, unknown>;
  const category = typeof b.category === 'string' ? b.category : 'development';
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
    : [description.slice(0, 200)];

  const deadline = typeof b.deadline === 'string' ? new Date(b.deadline) : null;
  const taskId = generateTaskId();

  // Attempt to extract escrow tx hash and payer address from the payment header if available
  const paymentHeader = c.req.header('x-payment') ?? c.req.header('payment-signature');
  let escrowTxHash: string | null = null;
  let payerAddress: string | null = null;
  if (paymentHeader) {
    try {
      const decoded = Buffer.from(paymentHeader, 'base64').toString('utf-8');
      const parsed = JSON.parse(decoded) as Record<string, unknown>;
      escrowTxHash = (parsed?.transaction as string) ?? (parsed?.tx_hash as string) ?? null;
      payerAddress = (parsed?.from as string) ?? (parsed?.payer as string) ?? (parsed?.sender as string) ?? null;
    } catch {
      // non-critical, best-effort
    }
  }

  await db.insert(tasks).values({
    id: taskId,
    creatorAgentId: agent.id,
    category,
    title,
    description,
    acceptanceCriteria,
    priceUsdc: priceUsdc.toFixed(6),
    pricePoints: null,
    status: 'open',
    deadline: deadline ?? null,
    autoAcceptFirst: Boolean(b.auto_accept_first),
    maxBids: typeof b.max_bids === 'number' ? Math.min(b.max_bids, 20) : 10,
    validationRequired: b.validation_required !== false,
    paymentMode: 'usdc',
    escrowTxHash,
  });

  await db.update(agents)
    .set({ tasksCreated: sql`tasks_created + 1`, updatedAt: sql`NOW()` })
    .where(eq(agents.id, agent.id));

  // Record the x402 payment for on-chain tracking
  await db.insert(x402Payments).values({
    taskId,
    payerAddress: payerAddress ?? 'unknown',
    recipientAddress: PLATFORM_EVM_ADDRESS,
    amountUsdc: priceUsdc.toFixed(6),
    txHash: escrowTxHash ?? `pending-${taskId}`,
    network: BASE_NETWORK,
    paymentType: 'escrow',
  });

  fireWebhook(agent.id, 'task.created', {
    task_id: taskId,
    payment_mode: 'usdc',
    price_usdc: priceUsdc,
  });

  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);

  return c.json(
    {
      id: task!.id,
      category: task!.category,
      title: task!.title,
      description: task!.description,
      acceptance_criteria: task!.acceptanceCriteria,
      price_usdc: parseFloat(task!.priceUsdc ?? '0'),
      payment_mode: task!.paymentMode,
      status: task!.status,
      deadline: task!.deadline?.toISOString() ?? null,
      created_at: task!.createdAt?.toISOString(),
    },
    201,
  );
});
