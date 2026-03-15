/**
 * Auto-approve unit tests — validates shouldAutoApprove() boundary conditions.
 *
 * Pure unit tests: no DB, no env. Tests the shouldAutoApprove() function directly.
 *
 * Test matrix:
 *   1.  rep=4.49  tasks=23  price=80    → NO  (rep below threshold)
 *   2.  rep=4.5   tasks=23  price=80    → YES (exact rep threshold)
 *   3.  rep=4.8   tasks=23  price=80    → YES (above threshold, points)
 *   4.  rep=4.8   tasks=9   price=80    → NO  (not enough tasks)
 *   5.  rep=4.8   tasks=10  price=80    → YES (exact tasks threshold)
 *   6.  rep=4.8   tasks=23  price=500   → YES (exactly at price cap)
 *   7.  rep=4.8   tasks=23  price=501   → NO  (over points price cap)
 *   8.  rep=4.8   tasks=23  usdc=50.0   → YES (exactly at USDC cap)
 *   9.  rep=4.8   tasks=23  usdc=50.01  → NO  (over USDC cap)
 *   10. rep=4.8   tasks=23  validation_required=false → NO (not applicable)
 *   11. approve reason includes all three fields
 *
 * Run: NODE_PATH=../upmoltwork/node_modules npx tsx src/tests/auto_approve.test.ts
 * (from the worktree directory with node_modules resolved)
 */

import { shouldAutoApprove } from '../lib/validation.js';

// ---------------------------------------------------------------------------
// Stubs — match the shape expected by shouldAutoApprove()
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = any;

function makeExecutor(rep: number, tasksCompleted: number): AnyRow {
  return { reputationScore: rep.toString(), tasksCompleted } as AnyRow;
}

function makePointsTask(price: number, validationRequired = true): AnyRow {
  return {
    validationRequired,
    paymentMode: 'points',
    pricePoints: price.toString(),
    priceUsdc: null,
  } as AnyRow;
}

function makeUsdcTask(priceUsdc: number, validationRequired = true): AnyRow {
  return {
    validationRequired,
    paymentMode: 'usdc',
    pricePoints: null,
    priceUsdc: priceUsdc.toString(),
  } as AnyRow;
}

// ---------------------------------------------------------------------------
// Minimal test runner (no external dependencies)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    const e = err as Error;
    console.error(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

function assert(value: boolean, message: string) {
  if (!value) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('\n🧪 shouldAutoApprove() boundary tests\n');

test('rep=4.49 tasks=23 price=80 → NO (reputation below threshold)', () => {
  const result = shouldAutoApprove(makeExecutor(4.49, 23), makePointsTask(80));
  assert(result.approve === false, `Expected approve=false, got ${result.approve} (${result.reason})`);
  assert(result.reason.includes('4.49'), `Reason should mention rep value, got: ${result.reason}`);
});

test('rep=4.5 tasks=23 price=80 → YES (exact rep threshold)', () => {
  const result = shouldAutoApprove(makeExecutor(4.5, 23), makePointsTask(80));
  assert(result.approve === true, `Expected approve=true, got ${result.approve} (${result.reason})`);
});

test('rep=4.8 tasks=23 price=80 → YES (above threshold, points)', () => {
  const result = shouldAutoApprove(makeExecutor(4.8, 23), makePointsTask(80));
  assert(result.approve === true, `Expected approve=true, got ${result.approve} (${result.reason})`);
});

test('rep=4.8 tasks=9 price=80 → NO (not enough tasks)', () => {
  const result = shouldAutoApprove(makeExecutor(4.8, 9), makePointsTask(80));
  assert(result.approve === false, `Expected approve=false, got ${result.approve} (${result.reason})`);
  assert(result.reason.includes('tasks_completed'), `Reason should mention tasks_completed, got: ${result.reason}`);
});

test('rep=4.8 tasks=10 price=80 → YES (exact tasks threshold)', () => {
  const result = shouldAutoApprove(makeExecutor(4.8, 10), makePointsTask(80));
  assert(result.approve === true, `Expected approve=true, got ${result.approve} (${result.reason})`);
});

test('rep=4.8 tasks=23 price=500 → YES (exactly at points price cap)', () => {
  const result = shouldAutoApprove(makeExecutor(4.8, 23), makePointsTask(500));
  assert(result.approve === true, `Expected approve=true, got ${result.approve} (${result.reason})`);
});

test('rep=4.8 tasks=23 price=501 → NO (over points price cap)', () => {
  const result = shouldAutoApprove(makeExecutor(4.8, 23), makePointsTask(501));
  assert(result.approve === false, `Expected approve=false, got ${result.approve} (${result.reason})`);
  assert(result.reason.includes('501'), `Reason should mention price, got: ${result.reason}`);
});

test('rep=4.8 tasks=23 usdc=50.0 → YES (exactly at USDC price cap)', () => {
  const result = shouldAutoApprove(makeExecutor(4.8, 23), makeUsdcTask(50.0));
  assert(result.approve === true, `Expected approve=true, got ${result.approve} (${result.reason})`);
});

test('rep=4.8 tasks=23 usdc=50.01 → NO (over USDC price cap)', () => {
  const result = shouldAutoApprove(makeExecutor(4.8, 23), makeUsdcTask(50.01));
  assert(result.approve === false, `Expected approve=false, got ${result.approve} (${result.reason})`);
  assert(result.reason.includes('50.01'), `Reason should mention usdc price, got: ${result.reason}`);
});

test('rep=4.8 tasks=23 validation_required=false → NO (not applicable)', () => {
  const result = shouldAutoApprove(makeExecutor(4.8, 23), makePointsTask(80, false));
  assert(result.approve === false, `Expected approve=false, got ${result.approve} (${result.reason})`);
  assert(result.reason === 'validation_not_required', `Expected reason=validation_not_required, got: ${result.reason}`);
});

test('approve=true reason includes reputation, tasks_completed, price fields', () => {
  const result = shouldAutoApprove(makeExecutor(4.8, 23), makePointsTask(80));
  assert(result.approve === true, `Expected approve=true, got ${result.approve}`);
  assert(result.reason.includes('reputation'), `Reason should mention reputation: ${result.reason}`);
  assert(result.reason.includes('tasks_completed'), `Reason should mention tasks_completed: ${result.reason}`);
  assert(result.reason.includes('price'), `Reason should mention price: ${result.reason}`);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
