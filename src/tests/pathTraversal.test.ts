/**
 * Path traversal protection tests for validationRunner.ts
 *
 * Tests the full path traversal defense:
 *   1. Early rejection of scriptNames containing /, \, or ..
 *   2. basename() extraction
 *   3. Allowlist check (simulated)
 *   4. resolve()+startsWith() VALIDATORS_DIR containment check
 *
 * Run: npx tsx src/tests/pathTraversal.test.ts
 */

import { basename, resolve, join } from 'node:path';

const VALIDATORS_DIR = '/fake/validators';

// Replicate the full validation logic from validationRunner.ts for unit testing
// (avoids DB dependency while still verifying the core logic)
const MOCK_ALLOWLIST = new Set(['check_url_posted.ts', 'check_markdown_structure.ts']);

function runCodeValidatorGuard(scriptName: string): { outcome: 'ok'; safe: string } | { outcome: 'error'; reason: string } {
  // Phase 1: Block path separators and traversal sequences
  if (/[/\\]/.test(scriptName) || scriptName.includes('..')) {
    return { outcome: 'error', reason: 'Unknown validator script' };
  }

  // Phase 2: Sanitize to basename (defensive)
  const safeScript = basename(scriptName);

  // Phase 3: Allowlist check — only known scripts may be executed
  if (!MOCK_ALLOWLIST.has(safeScript)) {
    return { outcome: 'error', reason: 'Unknown validator script' };
  }

  // Phase 4: Containment check
  const scriptPath = join(VALIDATORS_DIR, safeScript);
  const resolvedScriptPath = resolve(scriptPath);
  if (!resolvedScriptPath.startsWith(VALIDATORS_DIR + '/') && resolvedScriptPath !== VALIDATORS_DIR) {
    return { outcome: 'error', reason: 'Unknown validator script' };
  }

  return { outcome: 'ok', safe: safeScript };
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

console.log('\nPath traversal protection tests (Phase 1–4)\n');

// --- Should be rejected ---
const rejected: Array<{ label: string; input: string }> = [
  { label: '../../etc/passwd (classic traversal)', input: '../../etc/passwd' },
  { label: '../validators/../shell.ts', input: '../validators/../shell.ts' },
  { label: 'absolute path /etc/passwd', input: '/etc/passwd' },
  { label: 'backslash traversal', input: '..\\..\\windows\\system32' },
  { label: 'embedded slash subdir/script.ts', input: 'subdir/check_url_posted.ts' },
  { label: 'double dot only', input: '..' },
  { label: 'not in allowlist: evil.ts', input: 'evil.ts' },
  { label: 'not in allowlist: check_url_posted.js', input: 'check_url_posted.js' },
  { label: 'not in allowlist: shell_exec.ts', input: 'shell_exec.ts' },
  { label: 'empty string', input: '' },
  { label: 'null byte injection', input: 'check_url_posted.ts\x00.evil' },
];

for (const { label, input } of rejected) {
  const result = runCodeValidatorGuard(input);
  assert(`rejected: ${label}`, result.outcome === 'error',
    `expected error but got: ${JSON.stringify(result)}`);
}

// --- Should be accepted (in allowlist, no path traversal) ---
const accepted: Array<{ label: string; input: string; expectedSafe: string }> = [
  {
    label: 'check_url_posted.ts — valid allowlisted script',
    input: 'check_url_posted.ts',
    expectedSafe: 'check_url_posted.ts',
  },
  {
    label: 'check_markdown_structure.ts — valid allowlisted script',
    input: 'check_markdown_structure.ts',
    expectedSafe: 'check_markdown_structure.ts',
  },
];

for (const { label, input, expectedSafe } of accepted) {
  const result = runCodeValidatorGuard(input);
  assert(`accepted: ${label}`,
    result.outcome === 'ok' && result.safe === expectedSafe,
    `expected safe="${expectedSafe}", got: ${JSON.stringify(result)}`);
}

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
