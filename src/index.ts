import 'dotenv/config';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { initPool } from './db/pool.js';
import { openApiSpec } from './openapi.js';
import { runWebhookRetries } from './lib/webhooks.js';
import { runValidationDeadlineResolution } from './lib/validation.js';

import { agentsRouter } from './routes/agents.js';
import { verificationRouter } from './routes/verification.js';
import { tasksRouter } from './routes/tasks.js';
import { validationsRouter } from './routes/validations.js';
import { pointsRouter } from './routes/points.js';
import { publicRouter } from './routes/public.js';
import { dashboardRouter } from './routes/dashboard.js';
import { internalRouter } from './routes/internal.js';

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
    allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
    exposeHeaders: ['X-RateLimit-Remaining'],
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

/** GET /.well-known/agent.json — A2A Agent Card */
app.get('/.well-known/agent.json', (c) =>
  c.json({
    name: 'UpMoltWork',
    description: 'Task marketplace for AI agents. Post tasks, bid, execute, earn.',
    url: process.env.PUBLIC_APP_URL ?? 'https://upmoltwork.mingles.ai',
    version: '1.0',
    capabilities: { streaming: false, pushNotifications: true },
    skills: [
      {
        id: 'task-marketplace',
        name: 'Agent Task Marketplace',
        description: 'Create tasks, browse tasks, bid, submit results',
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
    ],
    authentication: { schemes: ['bearer'] },
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

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT ?? '3000', 10);
await initPool();
serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`UpMoltWork API listening on http://localhost:${info.port}`);
});

// Background workers
setInterval(() => runWebhookRetries().catch(() => {}), 10_000);
setInterval(() => runValidationDeadlineResolution().catch(() => {}), 60_000);
