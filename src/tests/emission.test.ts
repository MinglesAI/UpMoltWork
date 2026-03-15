/**
 * Emission tests — validates the daily emission service logic.
 *
 * Tests cover:
 *   - Activity multiplier table (api_calls_7d × gigs_last_7d → multiplier)
 *   - Emission decay table (verified agent count → base emission)
 *   - Balance cap enforcement (5000 max)
 *   - Full runDailyEmission() integration (per-agent crediting)
 *
 * Run: npm run test:emission
 * Requires: DATABASE_URL in .env
 */

import 'dotenv/config';
import { eq, sql, and } from 'drizzle-orm';
import { dbDirect, initPool } from '../db/pool.js';
import { agents, transactions } from '../db/schema/index.js';
import {
  getActivityMultiplier,
  getBaseEmission,
  runDailyEmission,
} from '../services/emissionService.js';

// ---------------------------------------------------------------------------
// Unit tests: multiplier table
// ---------------------------------------------------------------------------

function testMultiplierTable() {
  console.log('\n📐 Testing activity multiplier table...');

  const cases: { calls: number; gigs: number; expected: number; label: string }[] = [
    { calls: 0, gigs: 0, expected: 0, label: '0 calls → 0x' },
    { calls: 1, gigs: 0, expected: 0.5, label: '1 call, 0 gigs → 0.5x' },
    { calls: 5, gigs: 0, expected: 0.5, label: '5 calls → 0.5x' },
    { calls: 6, gigs: 0, expected: 1.0, label: '6 calls → 1.0x' },
    { calls: 20, gigs: 0, expected: 1.0, label: '20 calls → 1.0x' },
    { calls: 21, gigs: 0, expected: 1.0, label: '21 calls, 0 gigs → 1.0x (no gig bonus)' },
    { calls: 21, gigs: 1, expected: 1.25, label: '21 calls + 1 gig → 1.25x' },
    { calls: 50, gigs: 1, expected: 1.25, label: '50 calls + 1 gig → 1.25x' },
    { calls: 51, gigs: 0, expected: 1.0, label: '51 calls, 0 gigs → 1.0x' },
    { calls: 51, gigs: 1, expected: 1.0, label: '51 calls, 1 gig → 1.0x (need 2+)' },
    { calls: 51, gigs: 2, expected: 1.5, label: '51 calls + 2 gigs → 1.5x' },
    { calls: 100, gigs: 5, expected: 1.5, label: '100 calls + 5 gigs → 1.5x' },
  ];

  let passed = 0;
  let failed = 0;

  for (const { calls, gigs, expected, label } of cases) {
    const result = getActivityMultiplier(calls, gigs);
    if (Math.abs(result - expected) < 0.001) {
      console.log(`  ✅ ${label}`);
      passed++;
    } else {
      console.error(`  ❌ ${label}: expected ${expected}, got ${result}`);
      failed++;
    }
  }

  if (failed > 0) {
    throw new Error(`Multiplier table: ${failed} test(s) failed`);
  }
  console.log(`  → All ${passed} multiplier cases passed`);
}

// ---------------------------------------------------------------------------
// Unit tests: emission decay table
// ---------------------------------------------------------------------------

function testDecayTable() {
  console.log('\n📉 Testing emission decay table...');

  const cases: { count: number; expected: number; label: string }[] = [
    { count: 1, expected: 20, label: '1 verified agent → 20 🐚' },
    { count: 100, expected: 20, label: '100 verified agents → 20 🐚' },
    { count: 101, expected: 15, label: '101 verified agents → 15 🐚' },
    { count: 250, expected: 15, label: '250 verified agents → 15 🐚' },
    { count: 251, expected: 10, label: '251 verified agents → 10 🐚' },
    { count: 500, expected: 10, label: '500 verified agents → 10 🐚' },
    { count: 501, expected: 7, label: '501 verified agents → 7 🐚' },
    { count: 1000, expected: 7, label: '1000 verified agents → 7 🐚' },
    { count: 1001, expected: 5, label: '1001 verified agents → 5 🐚' },
    { count: 9999, expected: 5, label: '9999 verified agents → 5 🐚' },
  ];

  let passed = 0;
  let failed = 0;

  for (const { count, expected, label } of cases) {
    const result = getBaseEmission(count);
    if (result === expected) {
      console.log(`  ✅ ${label}`);
      passed++;
    } else {
      console.error(`  ❌ ${label}: expected ${expected}, got ${result}`);
      failed++;
    }
  }

  if (failed > 0) {
    throw new Error(`Decay table: ${failed} test(s) failed`);
  }
  console.log(`  → All ${passed} decay cases passed`);
}

// ---------------------------------------------------------------------------
// Integration tests: runDailyEmission()
// ---------------------------------------------------------------------------

const TEST_ACTIVE_LOW = 'agt_emtest1';    // 3 calls → 0.5x multiplier
const TEST_ACTIVE_MID = 'agt_emtest2';   // 10 calls → 1.0x multiplier
const TEST_ACTIVE_HIGH = 'agt_emtest3';  // 30 calls + 1 gig → 1.25x multiplier
const TEST_CAPPED = 'agt_emtest4';       // balance 4995 → should cap at 5000
const TEST_INACTIVE = 'agt_emtest5';    // last_api_call_at 8 days ago → skipped
const TEST_UNVERIFIED = 'agt_emtest6';  // status=unverified → skipped
const TEST_ZERO_CALLS = 'agt_emtest7';  // api_calls_7d=0 → 0x multiplier

const ALL_TEST_IDS = [
  TEST_ACTIVE_LOW, TEST_ACTIVE_MID, TEST_ACTIVE_HIGH,
  TEST_CAPPED, TEST_INACTIVE, TEST_UNVERIFIED, TEST_ZERO_CALLS,
];

async function setup() {
  console.log('\n🔧 Setting up integration test agents...');

  // Clean up prior runs
  for (const id of ALL_TEST_IDS) {
    await dbDirect.execute(sql`DELETE FROM transactions WHERE to_agent_id = ${id}`);
    await dbDirect.execute(sql`DELETE FROM agents WHERE id = ${id}`);
  }

  const now = new Date();
  const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);

  // Insert test agents
  await dbDirect.execute(sql`
    INSERT INTO agents (id, name, owner_twitter, status, balance_points, last_api_call_at, api_calls_7d, api_key_hash)
    VALUES
      (${TEST_ACTIVE_LOW},   'Low-activity agent',    'em_test_low',    'verified',   '100',  ${now.toISOString()},          3,   'hash1'),
      (${TEST_ACTIVE_MID},   'Mid-activity agent',    'em_test_mid',    'verified',   '100',  ${now.toISOString()},          10,  'hash2'),
      (${TEST_ACTIVE_HIGH},  'High-activity agent',   'em_test_high',   'verified',   '100',  ${now.toISOString()},          30,  'hash3'),
      (${TEST_CAPPED},       'Near-cap agent',        'em_test_capped', 'verified',   '4995', ${now.toISOString()},          10,  'hash4'),
      (${TEST_INACTIVE},     'Inactive agent',        'em_test_inact',  'verified',   '100',  ${eightDaysAgo.toISOString()}, 10,  'hash5'),
      (${TEST_UNVERIFIED},   'Unverified agent',      'em_test_unverf', 'unverified', '100',  ${now.toISOString()},          10,  'hash6'),
      (${TEST_ZERO_CALLS},   'Zero-calls agent',      'em_test_zero',   'verified',   '100',  ${now.toISOString()},          0,   'hash7')
  `);

  // Insert a task_payment for TEST_ACTIVE_HIGH (so they qualify for 1.25x)
  const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
  await dbDirect.execute(sql`
    INSERT INTO transactions (from_agent_id, to_agent_id, amount, currency, type, created_at)
    VALUES (NULL, ${TEST_ACTIVE_HIGH}, '50', 'points', 'task_payment', ${fiveDaysAgo.toISOString()})
  `);

  console.log('  ✅ Test agents created');
}

async function cleanup() {
  for (const id of ALL_TEST_IDS) {
    await dbDirect.execute(sql`DELETE FROM transactions WHERE to_agent_id = ${id}`);
    await dbDirect.execute(sql`DELETE FROM agents WHERE id = ${id}`);
  }
  console.log('🧹 Test data cleaned up');
}

async function runIntegrationTests() {
  console.log('\n🔄 Running runDailyEmission() integration test...');

  const result = await runDailyEmission();
  console.log('  Emission result:', JSON.stringify(result, null, 2));

  // Fetch agent balances after emission
  const rows = await dbDirect
    .select({ id: agents.id, balance: agents.balancePoints, apiCalls7d: agents.apiCalls7d })
    .from(agents)
    .where(
      sql`id IN (${TEST_ACTIVE_LOW}, ${TEST_ACTIVE_MID}, ${TEST_ACTIVE_HIGH}, ${TEST_CAPPED}, ${TEST_INACTIVE}, ${TEST_UNVERIFIED}, ${TEST_ZERO_CALLS})`
    );

  const byId = new Map(rows.map((r: { id: string; balance: string | null; apiCalls7d: number | null }) => [r.id, r]));

  function balance(id: string): number {
    return parseFloat(String(byId.get(id)?.balance ?? '0'));
  }

  // Base emission for current verified count (should be 5 verified test agents)
  // Note: real DB likely has other agents too, so we just verify relative to expected range
  const base = result.baseEmission;
  console.log(`  Base emission used: ${base} 🐚`);

  let failures = 0;

  // TEST_ACTIVE_LOW: 3 calls → 0.5x → base * 0.5
  const expectedLow = 100 + base * 0.5;
  const actualLow = balance(TEST_ACTIVE_LOW);
  if (Math.abs(actualLow - expectedLow) > 0.01) {
    console.error(`  ❌ LOW agent: expected ~${expectedLow}, got ${actualLow}`);
    failures++;
  } else {
    console.log(`  ✅ Low-activity agent: ${actualLow} (3 calls → 0.5x, +${base * 0.5} 🐚)`);
  }

  // TEST_ACTIVE_MID: 10 calls → 1.0x → base * 1.0
  const expectedMid = 100 + base * 1.0;
  const actualMid = balance(TEST_ACTIVE_MID);
  if (Math.abs(actualMid - expectedMid) > 0.01) {
    console.error(`  ❌ MID agent: expected ~${expectedMid}, got ${actualMid}`);
    failures++;
  } else {
    console.log(`  ✅ Mid-activity agent: ${actualMid} (10 calls → 1.0x, +${base} 🐚)`);
  }

  // TEST_ACTIVE_HIGH: 30 calls + 1 gig → 1.25x → base * 1.25
  const expectedHigh = 100 + base * 1.25;
  const actualHigh = balance(TEST_ACTIVE_HIGH);
  if (Math.abs(actualHigh - expectedHigh) > 0.01) {
    console.error(`  ❌ HIGH agent: expected ~${expectedHigh}, got ${actualHigh}`);
    failures++;
  } else {
    console.log(`  ✅ High-activity agent: ${actualHigh} (30 calls + 1 gig → 1.25x, +${base * 1.25} 🐚)`);
  }

  // TEST_CAPPED: started at 4995, +base*1.0 (10 calls) but cap at 5000
  const actualCapped = balance(TEST_CAPPED);
  if (Math.abs(actualCapped - 5000) > 0.01) {
    console.error(`  ❌ CAPPED agent: expected 5000 (cap), got ${actualCapped}`);
    failures++;
  } else {
    console.log(`  ✅ Near-cap agent capped at 5000 (not ${4995 + base} 🐚)`);
  }

  // TEST_INACTIVE: 8 days ago → NOT eligible (lastApiCallAt < 7d cutoff)
  const actualInactive = balance(TEST_INACTIVE);
  if (Math.abs(actualInactive - 100) > 0.01) {
    console.error(`  ❌ INACTIVE agent: expected 100 (unchanged), got ${actualInactive}`);
    failures++;
  } else {
    console.log(`  ✅ Inactive agent skipped (>7 days since last API call)`);
  }

  // TEST_UNVERIFIED: not verified → NOT eligible
  const actualUnverified = balance(TEST_UNVERIFIED);
  if (Math.abs(actualUnverified - 100) > 0.01) {
    console.error(`  ❌ UNVERIFIED agent: expected 100 (unchanged), got ${actualUnverified}`);
    failures++;
  } else {
    console.log(`  ✅ Unverified agent skipped`);
  }

  // TEST_ZERO_CALLS: api_calls_7d=0 → 0x multiplier → skipped
  const actualZero = balance(TEST_ZERO_CALLS);
  if (Math.abs(actualZero - 100) > 0.01) {
    console.error(`  ❌ ZERO-CALLS agent: expected 100 (unchanged), got ${actualZero}`);
    failures++;
  } else {
    console.log(`  ✅ Zero-calls agent skipped (0x multiplier)`);
  }

  // api_calls_7d should be reset to 0 for verified agents
  const verifiedIds = [TEST_ACTIVE_LOW, TEST_ACTIVE_MID, TEST_ACTIVE_HIGH, TEST_CAPPED, TEST_ZERO_CALLS];
  for (const id of verifiedIds) {
    const apiCalls = byId.get(id)?.apiCalls7d ?? -1;
    if (apiCalls !== 0) {
      console.error(`  ❌ api_calls_7d should be reset to 0 for ${id}, got ${apiCalls}`);
      failures++;
    }
  }
  console.log(`  ✅ api_calls_7d reset to 0 for all verified agents`);

  if (failures > 0) {
    throw new Error(`Integration tests: ${failures} test(s) failed`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('🚀 UpMoltWork Emission Tests\n');
  await initPool();

  try {
    // Unit tests (no DB needed)
    testMultiplierTable();
    testDecayTable();

    // Integration tests
    await setup();
    await runIntegrationTests();

    console.log('\n✅ All emission tests passed!');
  } catch (err) {
    console.error('\n❌ Test failed:', err);
    process.exitCode = 1;
  } finally {
    if (!process.env.KEEP_TEST_DATA) {
      await cleanup();
    } else {
      console.log('🔒 KEEP_TEST_DATA set — skipping cleanup');
    }
    process.exit(process.exitCode ?? 0);
  }
}

main();
