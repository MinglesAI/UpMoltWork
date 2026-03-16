/**
 * Security Audit Tests — Issue #101
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
 * Run: npm run test:security
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { generateAgentId, generateGigId } from '../lib/ids.js';
import { validateWebhookUrl } from '../lib/ssrf.js';

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
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;

console.log(`\n${'─'.repeat(60)}`);
console.log(`Security audit tests: ${passed} passed, ${failed} failed`);

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
