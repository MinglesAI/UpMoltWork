/**
 * SSRF Guard unit tests
 *
 * Tests validateOutboundUrl() against:
 *   - localhost / 127.0.0.1 (loopback)
 *   - 169.254.169.254 (link-local / metadata endpoint)
 *   - 10.10.10.10 (private class A)
 *   - 192.168.1.1 (private class C)
 *   - IPv6 loopback ::1
 *   - non-http protocol
 *   - valid public URL (should pass)
 *
 * Run: npx tsx src/tests/ssrfGuard.test.ts
 */

import { validateOutboundUrl, SsrfBlockedError } from '../lib/ssrfGuard.js';

type TestCase = {
  label: string;
  url: string;
  shouldBlock: boolean;
  note?: string;
};

const cases: TestCase[] = [
  { label: 'loopback hostname', url: 'http://localhost/foo', shouldBlock: true },
  { label: 'loopback IP 127.0.0.1', url: 'http://127.0.0.1/admin', shouldBlock: true },
  { label: 'link-local metadata 169.254.169.254', url: 'http://169.254.169.254/latest/meta-data/', shouldBlock: true },
  { label: 'private 10.x.x.x', url: 'http://10.10.10.10/internal', shouldBlock: true },
  { label: 'private 192.168.x.x', url: 'http://192.168.1.1/', shouldBlock: true },
  { label: 'private 172.16.x.x', url: 'http://172.16.0.1/', shouldBlock: true },
  { label: 'IPv6 loopback ::1', url: 'http://[::1]/admin', shouldBlock: true },
  { label: 'non-http protocol (ftp)', url: 'ftp://example.com/file', shouldBlock: true },
  { label: 'non-http protocol (file)', url: 'file:///etc/passwd', shouldBlock: true },
  // Public URLs — these require DNS so we mark them as expected-to-pass conceptually.
  // In a CI environment without external DNS, we skip DNS-dependent tests.
  { label: 'valid public URL', url: 'https://example.com/', shouldBlock: false, note: 'requires DNS' },
];

let passed = 0;
let failed = 0;

async function runCase(tc: TestCase) {
  try {
    await validateOutboundUrl(tc.url);
    // Did not throw
    if (tc.shouldBlock) {
      console.error(`  ✗ FAIL [${tc.label}]: expected SsrfBlockedError but URL was allowed`);
      failed++;
    } else {
      console.log(`  ✓ PASS [${tc.label}]: allowed (as expected)`);
      passed++;
    }
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      if (tc.shouldBlock) {
        console.log(`  ✓ PASS [${tc.label}]: blocked — ${err.reason}`);
        passed++;
      } else {
        console.error(`  ✗ FAIL [${tc.label}]: expected to pass but was blocked — ${err.reason}`);
        failed++;
      }
    } else {
      // DNS / network error for the "should pass" case — treat as skip in offline CI
      if (!tc.shouldBlock && tc.note?.includes('requires DNS')) {
        console.log(`  ~ SKIP [${tc.label}]: DNS not available (${(err as Error).message})`);
      } else {
        console.error(`  ✗ FAIL [${tc.label}]: unexpected error — ${(err as Error).message}`);
        failed++;
      }
    }
  }
}

async function main() {
  console.log('\nSSRF Guard tests\n');
  for (const tc of cases) {
    await runCase(tc);
  }
  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
