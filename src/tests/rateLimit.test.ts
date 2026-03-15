/**
 * Rate Limit Middleware Tests
 *
 * Tests the sliding-window rate limiter in-memory implementation.
 * Does NOT require a database or Redis connection.
 *
 * Run: npx tsx src/tests/rateLimit.test.ts
 */

import { createRateLimiter } from '../middleware/rateLimit.js';
import type { Context, Next } from 'hono';

// ---------------------------------------------------------------------------
// Minimal Context mock
// ---------------------------------------------------------------------------

interface MockResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

function makeMockContext(agentId?: string, ip = '1.2.3.4'): { ctx: Context; response: MockResponse } {
  const response: MockResponse = { status: 200, body: null, headers: {} };

  const ctx = {
    get: (key: string) => {
      if (key === 'agentId') return agentId;
      return undefined;
    },
    set: () => {},
    req: {
      header: (name: string) => {
        if (name === 'x-forwarded-for') return ip;
        return undefined;
      },
    },
    header: (name: string, value: string) => {
      response.headers[name] = value;
    },
    json: (body: unknown, status = 200) => {
      response.body = body;
      response.status = status;
      return new Response(JSON.stringify(body), { status });
    },
  } as unknown as Context;

  return { ctx, response };
}

const next: Next = async () => {};

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${(err as Error).message}`);
    failed++;
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('\n🧪 Rate Limit Middleware Tests\n');

// --- Basic allow/deny ---

console.log('Basic allow / deny:');

await test('allows requests under the limit', async () => {
  const limiter = createRateLimiter({ limit: 3 });

  for (let i = 0; i < 3; i++) {
    const { ctx, response } = makeMockContext('agent-001');
    await limiter(ctx, next);
    assert(response.status === 200, `Expected 200 on request ${i + 1}, got ${response.status}`);
  }
});

await test('returns 429 when limit exceeded', async () => {
  const limiter = createRateLimiter({ limit: 3 });
  const agentId = 'agent-exceed-001';

  // Exhaust the limit
  for (let i = 0; i < 3; i++) {
    const { ctx } = makeMockContext(agentId);
    await limiter(ctx, next);
  }

  // This one should be rate-limited
  const { ctx, response } = makeMockContext(agentId);
  const result = await limiter(ctx, next);
  assert(result !== undefined, 'Expected a Response from rate limiter');
  assert(response.status === 429, `Expected 429, got ${response.status}`);
});

await test('returns correct error body on 429', async () => {
  const limiter = createRateLimiter({ limit: 2 });
  const agentId = 'agent-body-001';

  for (let i = 0; i < 2; i++) {
    const { ctx } = makeMockContext(agentId);
    await limiter(ctx, next);
  }

  const { ctx, response } = makeMockContext(agentId);
  await limiter(ctx, next);
  const body = response.body as Record<string, unknown>;
  assert(body.error === 'rate_limit_exceeded', `Expected error 'rate_limit_exceeded', got '${body.error}'`);
  assert(typeof body.retry_after === 'number', `Expected retry_after to be a number, got ${typeof body.retry_after}`);
  assert((body.retry_after as number) > 0, `Expected retry_after > 0, got ${body.retry_after}`);
});

// --- Headers ---

console.log('\nResponse headers:');

await test('sets X-RateLimit-Limit header', async () => {
  const limiter = createRateLimiter({ limit: 10 });
  const { ctx, response } = makeMockContext('agent-hdr-001');
  await limiter(ctx, next);
  assert(response.headers['X-RateLimit-Limit'] === '10', `Expected X-RateLimit-Limit=10, got ${response.headers['X-RateLimit-Limit']}`);
});

await test('sets X-RateLimit-Remaining header (decrements correctly)', async () => {
  const limiter = createRateLimiter({ limit: 5 });
  const agentId = 'agent-rem-001';

  const { ctx: ctx1, response: r1 } = makeMockContext(agentId);
  await limiter(ctx1, next);
  assert(r1.headers['X-RateLimit-Remaining'] === '4', `After req 1: expected 4, got ${r1.headers['X-RateLimit-Remaining']}`);

  const { ctx: ctx2, response: r2 } = makeMockContext(agentId);
  await limiter(ctx2, next);
  assert(r2.headers['X-RateLimit-Remaining'] === '3', `After req 2: expected 3, got ${r2.headers['X-RateLimit-Remaining']}`);
});

await test('sets X-RateLimit-Reset header (unix timestamp)', async () => {
  const limiter = createRateLimiter({ limit: 10, windowMs: 60_000 });
  const { ctx, response } = makeMockContext('agent-reset-001');
  const before = Math.floor(Date.now() / 1000);
  await limiter(ctx, next);
  const after = Math.ceil(Date.now() / 1000) + 60;
  const reset = parseInt(response.headers['X-RateLimit-Reset'] ?? '0', 10);
  assert(reset >= before, `Reset should be >= ${before}, got ${reset}`);
  assert(reset <= after, `Reset should be <= ${after}, got ${reset}`);
});

await test('sets Retry-After header on 429', async () => {
  const limiter = createRateLimiter({ limit: 1 });
  const agentId = 'agent-retry-001';

  const { ctx: ctx1 } = makeMockContext(agentId);
  await limiter(ctx1, next);

  const { ctx: ctx2, response } = makeMockContext(agentId);
  await limiter(ctx2, next);
  const retryAfter = parseInt(response.headers['Retry-After'] ?? '0', 10);
  assert(retryAfter > 0, `Expected Retry-After > 0, got ${retryAfter}`);
});

// --- Isolation ---

console.log('\nAgent isolation:');

await test('different agents have independent counters', async () => {
  const limiter = createRateLimiter({ limit: 2 });

  // Exhaust agent A
  for (let i = 0; i < 2; i++) {
    const { ctx } = makeMockContext('agent-iso-A');
    await limiter(ctx, next);
  }

  // Agent B should still be allowed
  const { ctx, response } = makeMockContext('agent-iso-B');
  await limiter(ctx, next);
  assert(response.status === 200, `Expected agent B to be allowed (200), got ${response.status}`);
});

await test('unauthenticated requests are passed through (no agentId)', async () => {
  const limiter = createRateLimiter({ limit: 1 }); // very low limit
  // No agentId provided — should always pass through
  for (let i = 0; i < 5; i++) {
    const { ctx, response } = makeMockContext(undefined);
    await limiter(ctx, next);
    assert(response.status === 200, `Expected unauthenticated request ${i + 1} to pass, got ${response.status}`);
  }
});

// --- IP-based limiting ---

console.log('\nIP-based limiting:');

await test('IP-based limiter uses client IP as key', async () => {
  const limiter = createRateLimiter({ limit: 2, keyBy: 'ip' });
  const ip = '10.0.0.1';

  const { ctx: c1 } = makeMockContext('agent-ip-A', ip);
  await limiter(c1, next);
  const { ctx: c2 } = makeMockContext('agent-ip-A', ip);
  await limiter(c2, next);

  // Third request from same IP should be limited
  const { ctx: c3, response } = makeMockContext('agent-ip-A', ip);
  await limiter(c3, next);
  assert(response.status === 429, `Expected 429 on 3rd IP request, got ${response.status}`);
});

await test('different IPs have independent IP-based counters', async () => {
  const limiter = createRateLimiter({ limit: 1, keyBy: 'ip' });

  const { ctx: c1 } = makeMockContext('agent-ip-multi', '192.168.1.1');
  await limiter(c1, next);

  // Different IP → still allowed
  const { ctx: c2, response } = makeMockContext('agent-ip-multi', '192.168.1.2');
  await limiter(c2, next);
  assert(response.status === 200, `Expected different IP to be allowed (200), got ${response.status}`);
});

// --- Sliding window ---

console.log('\nSliding window behaviour:');

await test('requests become allowed again after window slides', async () => {
  const windowMs = 200; // 200ms window for fast test
  const limiter = createRateLimiter({ limit: 2, windowMs });
  const agentId = 'agent-slide-001';

  // Exhaust limit
  for (let i = 0; i < 2; i++) {
    const { ctx } = makeMockContext(agentId);
    await limiter(ctx, next);
  }

  // Should be blocked
  const { ctx: blocked, response: blockedResp } = makeMockContext(agentId);
  await limiter(blocked, next);
  assert(blockedResp.status === 429, 'Should be blocked immediately after limit');

  // Wait for the window to expire
  await new Promise((r) => setTimeout(r, windowMs + 50));

  // Should be allowed again
  const { ctx: allowed, response: allowedResp } = makeMockContext(agentId);
  await limiter(allowed, next);
  assert(allowedResp.status === 200, `Expected 200 after window reset, got ${allowedResp.status}`);
});

// --- Pre-configured limiters ---

console.log('\nPre-configured limiters:');

await test('rateLimitCreate has limit of 20', async () => {
  const { rateLimitCreate } = await import('../middleware/rateLimit.js');
  const agentId = 'agent-precfg-create';

  // Use 20 requests
  for (let i = 0; i < 20; i++) {
    const { ctx } = makeMockContext(agentId);
    await rateLimitCreate(ctx, next);
  }

  // 21st should be blocked
  const { ctx, response } = makeMockContext(agentId);
  await rateLimitCreate(ctx, next);
  assert(response.status === 429, `rateLimitCreate: expected 429 on 21st request, got ${response.status}`);
});

await test('rateLimitTransfer has limit of 5', async () => {
  const { rateLimitTransfer } = await import('../middleware/rateLimit.js');
  const agentId = 'agent-precfg-transfer';

  for (let i = 0; i < 5; i++) {
    const { ctx } = makeMockContext(agentId);
    await rateLimitTransfer(ctx, next);
  }

  const { ctx, response } = makeMockContext(agentId);
  await rateLimitTransfer(ctx, next);
  assert(response.status === 429, `rateLimitTransfer: expected 429 on 6th request, got ${response.status}`);
});

await test('rateLimitSubmit has limit of 10', async () => {
  const { rateLimitSubmit } = await import('../middleware/rateLimit.js');
  const agentId = 'agent-precfg-submit';

  for (let i = 0; i < 10; i++) {
    const { ctx } = makeMockContext(agentId);
    await rateLimitSubmit(ctx, next);
  }

  const { ctx, response } = makeMockContext(agentId);
  await rateLimitSubmit(ctx, next);
  assert(response.status === 429, `rateLimitSubmit: expected 429 on 11th request, got ${response.status}`);
});

await test('rateLimitGeneral has limit of 60', async () => {
  const { rateLimitGeneral } = await import('../middleware/rateLimit.js');
  const agentId = 'agent-precfg-general';

  for (let i = 0; i < 60; i++) {
    const { ctx } = makeMockContext(agentId);
    await rateLimitGeneral(ctx, next);
  }

  const { ctx, response } = makeMockContext(agentId);
  await rateLimitGeneral(ctx, next);
  assert(response.status === 429, `rateLimitGeneral: expected 429 on 61st request, got ${response.status}`);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error('\n❌ Some tests failed.\n');
  process.exit(1);
} else {
  console.log('\n✅ All tests passed.\n');
}
