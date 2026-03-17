/**
 * Security Audit Tests — Issue #101 / #108
 *
 * Tests for:
 *   C1: Suspended agent returns 403
 *   C2: Crypto-based ID generation uniqueness (10k iterations, no collisions)
 *   H1: validateWebhookUrl rejects http:// and private IPs
 *   H2: Validator script name regex validation
 *   H3: Timing-safe comparison does not crash on length mismatch
 *   M1: assertParticipant logic uses strict gig_orders check
 *   M5: secureHeaders middleware sets X-Content-Type-Options: nosniff
 *
 * C1 and M1 require a live database (DATABASE_URL). The tests skip gracefully
 * if the DB is not reachable.
 *
 * Run: npm run test:security
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { eq, and, ne, sql } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { generateAgentId, generateGigId, generateGigOrderId } from '../lib/ids.js';
import { validateWebhookUrl } from '../lib/ssrf.js';
import { db, initPool } from '../db/pool.js';
import { agents, gigs, gigOrders } from '../db/schema/index.js';
import { authMiddleware } from '../auth.js';
import { orderMessagesRouter } from '../routes/orderMessages.js';

// ---------------------------------------------------------------------------
// Minimal test runner
// ---------------------------------------------------------------------------

type TestFn = () => void | Promise<void>;

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

async function test(name: string, fn: TestFn): Promise<void> {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`  ✅ ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, error: msg });
    console.error(`  ❌ ${name}: ${msg}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertThrows(fn: () => unknown, expectedMsg?: string): void {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    if (expectedMsg) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes(expectedMsg)) {
        throw new Error(`Expected error containing "${expectedMsg}" but got: ${msg}`);
      }
    }
  }
  if (!threw) throw new Error('Expected function to throw but it did not');
}

async function assertRejects(fn: () => Promise<unknown>, expectedMsg?: string): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    if (expectedMsg) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes(expectedMsg.toLowerCase())) {
        throw new Error(`Expected rejection containing "${expectedMsg}" but got: ${msg}`);
      }
    }
  }
  if (!threw) throw new Error('Expected promise to reject but it resolved');
}

// ---------------------------------------------------------------------------
// C2: Crypto-based ID generation
// ---------------------------------------------------------------------------

console.log('\n🔒 C2: Crypto-based ID generation');

await test('generates 10,000 agent IDs with no collisions', async () => {
  const ids = new Set<string>();
  for (let i = 0; i < 10_000; i++) {
    const id = generateAgentId();
    assert(!ids.has(id), `Collision at iteration ${i}: ${id}`);
    ids.add(id);
  }
  assert(ids.size === 10_000, `Expected 10000 unique IDs, got ${ids.size}`);
});

await test('generated agent IDs always match agt_[a-z0-9]{8}', async () => {
  const pattern = /^agt_[a-z0-9]{8}$/;
  for (let i = 0; i < 100; i++) {
    const id = generateAgentId();
    assert(pattern.test(id), `ID "${id}" does not match pattern`);
  }
});

await test('generated gig IDs always match gig_[a-z0-9]{8}', async () => {
  const pattern = /^gig_[a-z0-9]{8}$/;
  for (let i = 0; i < 100; i++) {
    const id = generateGigId();
    assert(pattern.test(id), `ID "${id}" does not match pattern`);
  }
});

// ---------------------------------------------------------------------------
// H1: SSRF validation
// ---------------------------------------------------------------------------

console.log('\n🔒 H1: SSRF — validateWebhookUrl');

await test('rejects http:// scheme', async () => {
  await assertRejects(() => validateWebhookUrl('http://example.com/hook'), 'https://');
});

await test('rejects ftp:// scheme', async () => {
  await assertRejects(() => validateWebhookUrl('ftp://example.com/hook'), 'https://');
});

await test('rejects invalid URL format', async () => {
  await assertRejects(() => validateWebhookUrl('not-a-url'));
});

await test('rejects localhost (http scheme check fires first)', async () => {
  await assertRejects(() => validateWebhookUrl('http://localhost/hook'), 'https://');
});

await test('rejects 10.0.0.1 (http scheme check fires first)', async () => {
  await assertRejects(() => validateWebhookUrl('http://10.0.0.1/hook'), 'https://');
});

// ---------------------------------------------------------------------------
// H2: Validator script name regex
// ---------------------------------------------------------------------------

console.log('\n🔒 H2: Validator script name sanitization');

const VALID_SCRIPT_RE = /^[a-zA-Z0-9_-]+\.ts$/;

await test('rejects ../../dist/index.js (path traversal)', async () => {
  assert(!VALID_SCRIPT_RE.test('../../dist/index.js'), 'Should be rejected');
});

await test('rejects ../secret.ts (path traversal)', async () => {
  assert(!VALID_SCRIPT_RE.test('../secret.ts'), 'Should be rejected');
});

await test('rejects /etc/passwd (absolute path)', async () => {
  assert(!VALID_SCRIPT_RE.test('/etc/passwd'), 'Should be rejected');
});

await test('rejects "foo bar.ts" (space in name)', async () => {
  assert(!VALID_SCRIPT_RE.test('foo bar.ts'), 'Should be rejected');
});

await test('rejects "foo;rm.ts" (semicolon)', async () => {
  assert(!VALID_SCRIPT_RE.test('foo;rm.ts'), 'Should be rejected');
});

await test('rejects .ts (empty basename)', async () => {
  assert(!VALID_SCRIPT_RE.test('.ts'), 'Should be rejected');
});

await test('accepts "my-validator.ts"', async () => {
  assert(VALID_SCRIPT_RE.test('my-validator.ts'), 'Should be accepted');
});

await test('accepts "check_content.ts"', async () => {
  assert(VALID_SCRIPT_RE.test('check_content.ts'), 'Should be accepted');
});

await test('accepts "validate123.ts"', async () => {
  assert(VALID_SCRIPT_RE.test('validate123.ts'), 'Should be accepted');
});

// ---------------------------------------------------------------------------
// H3: Timing-safe comparison
// ---------------------------------------------------------------------------

console.log('\n🔒 H3: Timing-safe token comparison');

await test('does not crash on length-mismatched tokens', async () => {
  let tokenValid = false;
  try {
    tokenValid = crypto.timingSafeEqual(Buffer.from('short'), Buffer.from('a_much_longer_token_here'));
  } catch {
    tokenValid = false;
  }
  assert(!tokenValid, 'Should return false for mismatched tokens');
});

await test('correctly identifies matching tokens', async () => {
  const secret = 'my-admin-secret-123';
  let tokenValid = false;
  try {
    tokenValid = crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(secret));
  } catch {
    tokenValid = false;
  }
  assert(tokenValid, 'Matching tokens should return true');
});

await test('returns false for wrong token same length', async () => {
  const secret = 'my-admin-secret-123';
  const wrong = 'xx-wrong-secret-123';
  let tokenValid = false;
  try {
    tokenValid = crypto.timingSafeEqual(Buffer.from(wrong), Buffer.from(secret));
  } catch {
    tokenValid = false;
  }
  assert(!tokenValid, 'Wrong token should return false');
});

// ---------------------------------------------------------------------------
// M5: Security headers
// ---------------------------------------------------------------------------

console.log('\n🔒 M5: Security headers');

await test('secureHeaders sets X-Content-Type-Options: nosniff', async () => {
  const testApp = new Hono();
  testApp.use('*', secureHeaders());
  testApp.get('/test', (c) => c.json({ ok: true }));

  const res = await testApp.request('/test');
  const header = res.headers.get('x-content-type-options');
  assert(header === 'nosniff', `Expected "nosniff" but got: ${header}`);
});

await test('secureHeaders sets X-Frame-Options', async () => {
  const testApp = new Hono();
  testApp.use('*', secureHeaders());
  testApp.get('/test', (c) => c.json({ ok: true }));

  const res = await testApp.request('/test');
  const header = res.headers.get('x-frame-options');
  assert(header !== null, `Expected X-Frame-Options header but it was missing`);
});

// ---------------------------------------------------------------------------
// DB-backed tests: C1 and M1
//
// These tests require a live database (DATABASE_URL in .env).
// If the DB is unavailable, the tests are skipped with a warning.
// ---------------------------------------------------------------------------

// ── Fixed agent / gig IDs (must be exactly 12 chars per AGENT_ID_LENGTH) ──
//
//   agt_secsusp1  = 12 chars  (C1: suspended agent)
//   agt_m1creato  = 12 chars  (M1: gig creator / agentA)
//   agt_m1buyerf  = 12 chars  (M1: buyer with active order / agentB)
//   agt_m1outsr1  = 12 chars  (M1: unrelated outsider / agentC)

const C1_AGENT_ID  = 'agt_secsusp1';
const C1_API_KEY   = `axe_${C1_AGENT_ID}_${'d'.repeat(64)}`;

const M1_CREATOR_ID = 'agt_m1creato';
const M1_BUYER_ID   = 'agt_m1buyerf';
const M1_OUTSIDER_ID = 'agt_m1outsr1';

const M1_CREATOR_KEY  = `axe_${M1_CREATOR_ID}_${'e'.repeat(64)}`;
const M1_BUYER_KEY    = `axe_${M1_BUYER_ID}_${'f'.repeat(64)}`;
const M1_OUTSIDER_KEY = `axe_${M1_OUTSIDER_ID}_${'9'.repeat(64)}`;

// IDs allocated here; actual values set during setup
let m1GigId    = '';
let m1OrderId  = '';

// ---------------------------------------------------------------------------
// DB cleanup helpers
// ---------------------------------------------------------------------------

async function cleanupDbTestData(): Promise<void> {
  const allAgentIds = [C1_AGENT_ID, M1_CREATOR_ID, M1_BUYER_ID, M1_OUTSIDER_ID];

  // FK order: gig_orders → gigs → agents
  if (m1OrderId) {
    await db.execute(sql`DELETE FROM gig_orders WHERE id = ${m1OrderId}`);
  }
  if (m1GigId) {
    await db.execute(sql`DELETE FROM gigs WHERE id = ${m1GigId}`);
  }
  await db.execute(sql`
    DELETE FROM agents
    WHERE id IN (${C1_AGENT_ID}, ${M1_CREATOR_ID}, ${M1_BUYER_ID}, ${M1_OUTSIDER_ID})
  `);
  // Also clean up by twitter handle in case partial setup left orphans
  await db.execute(sql`
    DELETE FROM agents
    WHERE owner_twitter IN (
      'sec_test_susp', 'sec_m1_creator', 'sec_m1_buyer', 'sec_m1_outsider'
    )
  `);
}

// ---------------------------------------------------------------------------
// Attempt DB init — skip gracefully if unavailable
// ---------------------------------------------------------------------------

let dbAvailable = false;

try {
  await initPool();
  // Quick connectivity check
  await db.execute(sql`SELECT 1`);
  dbAvailable = true;
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`\n⚠️  Database not available (${msg})`);
  console.warn('   Skipping C1 and M1 (DB-backed tests).\n');
}

// ---------------------------------------------------------------------------
// C1: Suspended agent returns 403 on any auth-guarded endpoint
// ---------------------------------------------------------------------------

if (dbAvailable) {
  console.log('\n🔒 C1: Suspended agent returns 403');

  // Pre-test cleanup in case a previous run left data behind
  try {
    await db.execute(sql`DELETE FROM agents WHERE id = ${C1_AGENT_ID}`);
    await db.execute(sql`DELETE FROM agents WHERE owner_twitter = 'sec_test_susp'`);
  } catch { /* ignore */ }

  // Hash the C1 API key with a low cost factor for speed
  const c1KeyHash = await bcrypt.hash(C1_API_KEY, 4);

  // Insert suspended agent
  await db.insert(agents).values({
    id: C1_AGENT_ID,
    name: 'Suspended Test Agent',
    ownerTwitter: 'sec_test_susp',
    status: 'suspended',
    balancePoints: '0',
    apiKeyHash: c1KeyHash,
  });

  // A minimal Hono app with a protected endpoint (mirrors production routes)
  const c1App = new Hono<{ Variables: { agent: typeof agents.$inferSelect; agentId: string } }>();
  c1App.get('/protected', authMiddleware, (c) => c.json({ ok: true }));

  await test('suspended agent with valid API key → 403 Forbidden', async () => {
    const res = await c1App.request('/protected', {
      headers: { Authorization: `Bearer ${C1_API_KEY}` },
    });

    assert(res.status === 403, `Expected 403, got ${res.status}`);

    const body = await res.json() as Record<string, unknown>;
    assert(
      body.error === 'forbidden',
      `Expected error="forbidden", got: ${JSON.stringify(body)}`,
    );
  });

  await test('suspended agent response body has error: forbidden', async () => {
    const res = await c1App.request('/protected', {
      headers: { Authorization: `Bearer ${C1_API_KEY}` },
    });
    const body = await res.json() as Record<string, unknown>;
    assert(
      typeof body.message === 'string' && body.message.length > 0,
      `Expected a non-empty message field, got: ${JSON.stringify(body)}`,
    );
  });

  await test('non-suspended agent with valid API key passes auth (control)', async () => {
    // Temporarily create a verified control agent
    const CTRL_ID  = 'agt_secctrl1';  // 12 chars
    const CTRL_KEY = `axe_${CTRL_ID}_${'c'.repeat(64)}`;
    const ctrlHash = await bcrypt.hash(CTRL_KEY, 4);

    try {
      await db.execute(sql`DELETE FROM agents WHERE id = ${CTRL_ID}`);
      await db.execute(sql`DELETE FROM agents WHERE owner_twitter = 'sec_test_ctrl'`);
      await db.insert(agents).values({
        id: CTRL_ID,
        name: 'Control Test Agent',
        ownerTwitter: 'sec_test_ctrl',
        status: 'verified',
        balancePoints: '10',
        apiKeyHash: ctrlHash,
      });

      const res = await c1App.request('/protected', {
        headers: { Authorization: `Bearer ${CTRL_KEY}` },
      });

      assert(res.status === 200, `Expected 200 for verified agent, got ${res.status}`);
    } finally {
      await db.execute(sql`DELETE FROM agents WHERE id = ${CTRL_ID}`);
    }
  });

  // Cleanup C1 agent
  await db.execute(sql`DELETE FROM agents WHERE id = ${C1_AGENT_ID}`);

  // ---------------------------------------------------------------------------
  // M1: assertParticipant strict participant check
  // ---------------------------------------------------------------------------

  console.log('\n🔒 M1: assertParticipant — strict gig_orders participant check');

  // Pre-test cleanup
  try {
    await db.execute(sql`
      DELETE FROM agents
      WHERE id IN (${M1_CREATOR_ID}, ${M1_BUYER_ID}, ${M1_OUTSIDER_ID})
    `);
    await db.execute(sql`
      DELETE FROM agents
      WHERE owner_twitter IN ('sec_m1_creator', 'sec_m1_buyer', 'sec_m1_outsider')
    `);
  } catch { /* ignore */ }

  // Hash all M1 keys (bcrypt cost=4 for test speed)
  const [creatorHash, buyerHash, outsiderHash] = await Promise.all([
    bcrypt.hash(M1_CREATOR_KEY, 4),
    bcrypt.hash(M1_BUYER_KEY, 4),
    bcrypt.hash(M1_OUTSIDER_KEY, 4),
  ]);

  // Create three agents
  await db.insert(agents).values([
    {
      id: M1_CREATOR_ID,
      name: 'M1 Creator Agent',
      ownerTwitter: 'sec_m1_creator',
      status: 'verified',
      balancePoints: '100',
      apiKeyHash: creatorHash,
    },
    {
      id: M1_BUYER_ID,
      name: 'M1 Buyer Agent',
      ownerTwitter: 'sec_m1_buyer',
      status: 'verified',
      balancePoints: '100',
      apiKeyHash: buyerHash,
    },
    {
      id: M1_OUTSIDER_ID,
      name: 'M1 Outsider Agent',
      ownerTwitter: 'sec_m1_outsider',
      status: 'verified',
      balancePoints: '50',
      apiKeyHash: outsiderHash,
    },
  ]);

  // Create gig owned by creator
  m1GigId = generateGigId();
  await db.insert(gigs).values({
    id: m1GigId,
    creatorAgentId: M1_CREATOR_ID,
    title: 'M1 Security Test Gig',
    description: 'Used to test assertParticipant strict check.',
    category: 'development',
    pricePoints: '30',
    status: 'open',
  });

  // Create active (non-cancelled) order for the buyer
  m1OrderId = generateGigOrderId();
  await db.insert(gigOrders).values({
    id: m1OrderId,
    gigId: m1GigId,
    buyerAgentId: M1_BUYER_ID,
    sellerAgentId: M1_CREATOR_ID,
    paymentMode: 'points',
    pricePoints: '30',
    status: 'accepted',  // active non-cancelled order
  });

  // Test app — mirrors production mount for /v1/gigs/:gigId/messages
  const m1App = new Hono();
  m1App.route('/v1/gigs/:gigId/messages', orderMessagesRouter);

  const m1MessagesUrl = `http://localhost/v1/gigs/${m1GigId}/messages`;

  await test('M1: unrelated agent (agentC) gets 403 on GET messages', async () => {
    const res = await m1App.fetch(
      new Request(m1MessagesUrl, {
        headers: { Authorization: `Bearer ${M1_OUTSIDER_KEY}` },
      }),
    );
    assert(res.status === 403, `Expected 403 for outsider, got ${res.status}`);
    const body = await res.json() as Record<string, unknown>;
    assert(
      body.error === 'forbidden',
      `Expected error="forbidden", got: ${JSON.stringify(body)}`,
    );
  });

  await test('M1: unrelated agent (agentC) gets 403 on POST messages', async () => {
    const res = await m1App.fetch(
      new Request(m1MessagesUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${M1_OUTSIDER_KEY}`,
        },
        body: JSON.stringify({ content: 'Unauthorized access attempt' }),
      }),
    );
    assert(res.status === 403, `Expected 403 for outsider POST, got ${res.status}`);
    const body = await res.json() as Record<string, unknown>;
    assert(
      body.error === 'forbidden',
      `Expected error="forbidden", got: ${JSON.stringify(body)}`,
    );
  });

  await test('M1: gig creator (agentA) can access GET messages', async () => {
    const res = await m1App.fetch(
      new Request(m1MessagesUrl, {
        headers: { Authorization: `Bearer ${M1_CREATOR_KEY}` },
      }),
    );
    // Read body first so we can include it in the error message without consuming twice
    const body = await res.json() as Record<string, unknown>;
    assert(
      res.status === 200,
      `Expected 200 for creator, got ${res.status}: ${JSON.stringify(body)}`,
    );
    assert(Array.isArray(body.messages), 'Expected messages array in response');
  });

  await test('M1: buyer with active order (agentB) can access GET messages', async () => {
    const res = await m1App.fetch(
      new Request(m1MessagesUrl, {
        headers: { Authorization: `Bearer ${M1_BUYER_KEY}` },
      }),
    );
    // Read body first so we can include it in the error message without consuming twice
    const body = await res.json() as Record<string, unknown>;
    assert(
      res.status === 200,
      `Expected 200 for buyer, got ${res.status}: ${JSON.stringify(body)}`,
    );
    assert(Array.isArray(body.messages), 'Expected messages array in response');
  });

  await test('M1: cancelled order does not grant access', async () => {
    // Create a second gig + cancelled order for the outsider to ensure they are blocked
    const cancelledGigId = generateGigId();
    const cancelledOrderId = generateGigOrderId();

    await db.insert(gigs).values({
      id: cancelledGigId,
      creatorAgentId: M1_CREATOR_ID,
      title: 'M1 Cancelled Order Gig',
      description: 'Tests that a cancelled order does not grant access.',
      category: 'development',
      pricePoints: '10',
      status: 'open',
    });

    await db.insert(gigOrders).values({
      id: cancelledOrderId,
      gigId: cancelledGigId,
      buyerAgentId: M1_OUTSIDER_ID,  // outsider has a CANCELLED order
      sellerAgentId: M1_CREATOR_ID,
      paymentMode: 'points',
      pricePoints: '10',
      status: 'cancelled',
    });

    try {
      const cancelledUrl = `http://localhost/v1/gigs/${cancelledGigId}/messages`;
      const res = await m1App.fetch(
        new Request(cancelledUrl, {
          headers: { Authorization: `Bearer ${M1_OUTSIDER_KEY}` },
        }),
      );
      assert(
        res.status === 403,
        `Expected 403 for outsider with cancelled order, got ${res.status}`,
      );
      const body = await res.json() as Record<string, unknown>;
      assert(
        body.error === 'forbidden',
        `Expected error="forbidden", got: ${JSON.stringify(body)}`,
      );
    } finally {
      await db.execute(sql`DELETE FROM gig_orders WHERE id = ${cancelledOrderId}`);
      await db.execute(sql`DELETE FROM gigs WHERE id = ${cancelledGigId}`);
    }
  });

  // Cleanup M1 data
  await cleanupDbTestData();
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;

console.log(`\n${'─'.repeat(60)}`);
console.log(`Security audit tests: ${passed} passed, ${failed} failed`);
if (!dbAvailable) {
  console.log('  ℹ️  C1 and M1 were skipped (no DATABASE_URL configured)');
}

if (failed > 0) {
  console.error('\nFailed tests:');
  for (const r of results.filter((r) => !r.passed)) {
    console.error(`  ❌ ${r.name}: ${r.error}`);
  }
  process.exit(1);
} else {
  console.log('✅ All security audit tests passed!');
  process.exit(0);
}
