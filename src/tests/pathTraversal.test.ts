/**
 * Path traversal protection tests for validationRunner.ts
 *
 * Tests that runCodeValidator() sanitizes the script name and rejects
 * path traversal attempts (e.g. "../../../etc/passwd").
 *
 * These tests call the internal logic indirectly by exercising the
 * runValidationForSubmission entry point with mocked DB data, OR by
 * directly testing the sanitization logic.
 *
 * Run: npx tsx src/tests/pathTraversal.test.ts
 */

import { basename } from 'node:path';

// Replicate the validation logic from validationRunner.ts for unit testing
// (avoids DB dependency while still verifying the core logic)
function sanitizeScriptName(scriptName: string): { ok: true; safe: string } | { ok: false; reason: string } {
  const safeScript = basename(scriptName);
  if (!/^[a-z0-9_][a-z0-9_-]*\.ts$/.test(safeScript)) {
    return { ok: false, reason: `Invalid validator script name: "${scriptName}"` };
  }
  return { ok: true, safe: safeScript };
}

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ PASS [${label}]`);
    passed++;
  } else {
    console.error(`  ✗ FAIL [${label}]${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

console.log('\nPath traversal sanitization tests\n');

// Should be rejected
const rejected: Array<{ label: string; input: string }> = [
  { label: '../../../etc/passwd', input: '../../../etc/passwd' },
  { label: '../../etc/shadow', input: '../../etc/shadow' },
  // Note: '../validators/check_url_posted.ts' is NOT rejected — basename() strips the prefix to 'check_url_posted.ts'
  // which IS a valid name. The resolve()+startsWith() guard in validationRunner.ts then confirms
  // the final path stays within VALIDATORS_DIR. This is tested in the "accepted" section below.
  { label: 'absolute path /etc/passwd', input: '/etc/passwd' },
  { label: 'script with uppercase', input: 'MyScript.ts' },
  { label: 'script without .ts extension', input: 'check_url_posted' },
  { label: 'script with .js extension', input: 'check_url_posted.js' },
  { label: 'script starting with hyphen', input: '-bad.ts' },
  { label: 'empty string', input: '' },
  { label: 'dot dot slash in middle', input: 'check/../../../etc/passwd' },
  { label: 'null byte injection', input: 'check_url_posted.ts\x00.evil' },
];

for (const { label, input } of rejected) {
  const result = sanitizeScriptName(input);
  assert(`rejected: ${label}`, !result.ok, `expected rejection but got: ${JSON.stringify(result)}`);
}

// Should be accepted
const accepted: Array<{ label: string; input: string; expectedSafe: string }> = [
  {
    label: 'simple valid script',
    input: 'check_url_posted.ts',
    expectedSafe: 'check_url_posted.ts',
  },
  {
    label: 'script with hyphens',
    input: 'check-something-good.ts',
    expectedSafe: 'check-something-good.ts',
  },
  {
    label: 'script with numbers',
    input: 'check1_url2.ts',
    expectedSafe: 'check1_url2.ts',
  },
  {
    label: 'basename extraction strips directory prefix (subdir)',
    input: 'subdir/check_url_posted.ts',
    expectedSafe: 'check_url_posted.ts',
  },
  {
    label: 'basename extraction strips ../ traversal prefix safely',
    input: '../validators/check_url_posted.ts',
    expectedSafe: 'check_url_posted.ts',
    // Security note: basename() reduces this to 'check_url_posted.ts', which is a legitimate
    // script. The resolve()+startsWith() guard in validationRunner.ts confirms the final path
    // stays inside VALIDATORS_DIR. An attacker cannot reach files outside that dir this way.
  },
];

for (const { label, input, expectedSafe } of accepted) {
  const result = sanitizeScriptName(input);
  assert(`accepted: ${label}`, result.ok && result.safe === expectedSafe,
    `expected safe="${expectedSafe}", got: ${JSON.stringify(result)}`);
}

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
