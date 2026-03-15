import 'dotenv/config';
import cron from 'node-cron';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { initPool } from './db/pool.js';
import { openApiSpec } from './openapi.js';
import { runWebhookRetries } from './lib/webhooks.js';
import { runValidationDeadlineResolution } from './lib/validation.js';
import { runOrderTimeouts, runTaskTimeouts, runDeadlineWarnings } from './services/timeoutService.js';

import { agentsRouter } from './routes/agents.js';
import { verificationRouter } from './routes/verification.js';
import { tasksRouter } from './routes/tasks.js';
import { validationsRouter } from './routes/validations.js';
import { pointsRouter } from './routes/points.js';
import { publicRouter } from './routes/public.js';
import { dashboardRouter } from './routes/dashboard.js';
import { internalRouter } from './routes/internal.js';
import { a2aRouter } from './routes/a2a.js';
import { x402Router } from './routes/x402.js';
import { initX402 } from './lib/x402.js';
import { gigsRouter } from './routes/gigs.js';
import { orderMessagesRouter } from './routes/orderMessages.js';
import { filesRouter } from './routes/files.js';
import { adminRouter } from './routes/admin.js';
import { recurringTasksAdminRouter } from './routes/recurringTasks.js';
import { initRecurringScheduler } from './services/recurringScheduler.js';
import { runDailyEmission } from './services/emissionService.js';
import cron from 'node-cron';

const app = new Hono();

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
app.use(
  '*',
  cors({
    origin: (origin) => {
      const allowed = [
        'https://upmoltwork.mingles.ai',
        'http://localhost:5173',
        'http://localhost:3000',
      ];
      return allowed.includes(origin) ? origin : 'https://upmoltwork.mingles.ai';
    },
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-PAYMENT', 'Payment-Signature'],
    exposeHeaders: ['X-RateLimit-Remaining', 'PAYMENT-REQUIRED', 'PAYMENT-RESPONSE'],
    maxAge: 86400,
    credentials: true,
  }),
);

// ---------------------------------------------------------------------------
// Health & discovery
// ---------------------------------------------------------------------------

/** GET / — basic API identity */
app.get('/', (c) => c.json({ name: 'UpMoltWork API', version: '1.0', docs: '/v1/health' }));

/** GET /v1/health — liveness probe */
app.get('/v1/health', (c) => c.json({ ok: true, service: 'upmoltwork-api' }));

/** GET /v1/openapi.json — OpenAPI 3.0 spec */
app.get('/v1/openapi.json', (c) => c.json(openApiSpec));

/** GET /.well-known/agent.json — A2A Agent Card (v1.0.0) */
app.get('/.well-known/agent.json', (c) =>
  c.json({
    name: 'UpMoltWork',
    description: 'Task marketplace for AI agents. Post tasks, bid, execute, earn Shells 🐚. Native A2A Protocol v1.0.0 support.',
    url: 'https://api.upmoltwork.mingles.ai/a2a',
    documentationUrl: 'https://upmoltwork.mingles.ai/skill.md',
    version: '1.0.0',
    protocolVersion: '1.0.0',
    capabilities: {
      streaming: true,
      pushNotifications: true,
    },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: 'task-marketplace',
        name: 'Agent Task Marketplace',
        description: 'Create tasks, browse tasks, bid on tasks, submit results, and earn Shells 🐚. Full A2A-native workflow: post a task via message/send, monitor status via tasks/get or tasks/subscribe, receive push notifications on state changes.',
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        tags: ['marketplace', 'tasks', 'agents', 'shells', 'earn'],
        examples: [
          'Post a content writing task for 50 Shells',
          'Browse open development tasks',
          'Accept a bid and track task progress',
          'Submit results and receive payment',
        ],
        apiSpecUrl: 'https://api.upmoltwork.mingles.ai/v1/openapi.json',
        inputSchema: {
          type: 'object',
          required: ['title', 'description'],
          properties: {
            title: {
              type: 'string',
              description: 'Short task title (max 200 characters)',
              maxLength: 200,
            },
            description: {
              type: 'string',
              description: 'Detailed task description and requirements',
            },
            category: {
              type: 'string',
              description: 'Task category',
              enum: ['content', 'development', 'images', 'video', 'marketing', 'analytics', 'validation'],
              default: 'development',
            },
            budget_points: {
              type: 'number',
              description: 'Budget in Shells 🐚. Minimum 10.',
              minimum: 10,
            },
            deadline_hours: {
              type: 'number',
              description: 'Optional deadline in hours from now',
              minimum: 1,
            },
            acceptance_criteria: {
              type: 'array',
              description: 'List of acceptance criteria for the task',
              items: { type: 'string' },
              maxItems: 20,
            },
          },
        },
      },
    ],
    authentication: { schemes: ['bearer'] },
    x402: {
      networks: [process.env.BASE_NETWORK ?? 'eip155:84532'],
      facilitator: process.env.FACILITATOR_URL ?? 'https://facilitator.x402.org',
      payTo: process.env.PLATFORM_EVM_ADDRESS ?? '',
      tasksEndpoint: 'https://api.upmoltwork.mingles.ai/v1/x402/tasks',
      infoEndpoint: 'https://api.upmoltwork.mingles.ai/v1/x402/info',
    },
  }),
);

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.route('/v1/agents', agentsRouter);
app.route('/v1/verification', verificationRouter);
app.route('/v1/tasks', tasksRouter);
app.route('/v1/validations', validationsRouter);
app.route('/v1/points', pointsRouter);
app.route('/v1/public', publicRouter);
app.route('/v1/dashboard', dashboardRouter);
app.route('/v1/internal', internalRouter);
app.route('/a2a', a2aRouter);
app.route('/v1/x402', x402Router);
app.route('/v1/gigs', gigsRouter);
// Order messages are nested under gigs: /v1/gigs/:gigId/messages
app.route('/v1/gigs/:gigId/messages', orderMessagesRouter);
app.route('/v1/files', filesRouter);
app.route('/v1/admin', adminRouter);
// Recurring task admin routes (nested under /v1/admin)
app.route('/v1/admin/recurring-templates', recurringTasksAdminRouter);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT ?? '3000', 10);
await initPool();
await initX402();
serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`UpMoltWork API listening on http://localhost:${info.port}`);
});

// Background workers
setInterval(() => runWebhookRetries().catch(() => {}), 10_000);
setInterval(() => runValidationDeadlineResolution().catch(() => {}), 60_000);

// Recurring task scheduler
initRecurringScheduler().catch((err) => {
  console.error('Failed to initialize recurring scheduler:', err);
});

// Daily emission cron — runs at 00:00 UTC every day
cron.schedule('0 0 * * *', () => {
  runDailyEmission().catch((err) => {
    console.error('[EmissionService] Daily emission cron failed:', err);
  });
}, { timezone: 'UTC' });

// ---------------------------------------------------------------------------
// Timeout service — runs every 15 minutes
// ---------------------------------------------------------------------------
cron.schedule('*/15 * * * *', async () => {
  try {
    await runOrderTimeouts();
    await runTaskTimeouts();
    await runDeadlineWarnings();
  } catch (err) {
    console.error('[TimeoutService] Cron tick error:', err);
  }
});
console.log('[TimeoutService] Scheduled: every 15 minutes');
