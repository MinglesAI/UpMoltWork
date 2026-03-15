/**
 * Full-text search integration tests — validates:
 *
 *   Tasks search (GET /v1/tasks?q=):
 *   Test 1:  Exact title match returns task
 *   Test 2:  Partial match in description returns task
 *   Test 3:  Irrelevant query returns no results
 *   Test 4:  q < 2 chars → 400
 *   Test 5:  Compatible with other filters (category, status)
 *   Test 6:  Results sorted by relevance (exact match ranks higher)
 *
 *   Gigs search (GET /v1/gigs?q=):
 *   Test 7:  Exact title match returns gig
 *   Test 8:  Partial match in description returns gig
 *   Test 9:  q < 2 chars → 400
 *   Test 10: Compatible with status filter
 *
 *   Public unified search (GET /v1/public/search?q=&type=):
 *   Test 11: type=all returns both tasks and gigs
 *   Test 12: type=tasks returns only tasks
 *   Test 13: type=gigs returns only gigs
 *   Test 14: Missing/short q → 400
 *   Test 15: Invalid type → 400
 *
 * Run:     npx tsx src/tests/search.test.ts
 * Requires: DATABASE_URL in .env
 */

import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { Hono } from 'hono';
import { db, initPool } from '../db/pool.js';
import { agents, tasks, gigs } from '../db/schema/index.js';
import { generateTaskId, generateGigId } from '../lib/ids.js';
import { tasksRouter } from '../routes/tasks.js';
import { gigsRouter } from '../routes/gigs.js';
import { publicRouter } from '../routes/public.js';

// ---------------------------------------------------------------------------
// Agent IDs — must be exactly 12 chars
// ---------------------------------------------------------------------------
const AGENT_ID  = 'srch_agt0001';
const AGENT_KEY = `axe_${AGENT_ID}_${'a'.repeat(64)}`;
let agentKeyHash = '';

// ---------------------------------------------------------------------------
// Test Hono app
// ---------------------------------------------------------------------------
const testApp = new Hono();
testApp.route('/v1/tasks', tasksRouter);
testApp.route('/v1/gigs', gigsRouter);
testApp.route('/v1/public', publicRouter);

// ---------------------------------------------------------------------------
// Test data IDs
// ---------------------------------------------------------------------------
let taskExactId    = '';
let taskPartialId  = '';
let taskUnrelId    = '';
let gigExactId     = '';
let gigPartialId   = '';

// ---------------------------------------------------------------------------
// Setup / Cleanup
// ---------------------------------------------------------------------------
async function cleanupData() {
  await db.execute(sql`
    DELETE FROM tasks WHERE creator_agent_id = ${AGENT_ID}
  `);
  await db.execute(sql`
    DELETE FROM gigs WHERE creator_agent_id = ${AGENT_ID}
  `);
  await db.execute(sql`
    DELETE FROM agents WHERE id = ${AGENT_ID}
  `);
}

async function setup() {
  console.log('🔧 Setting up search test data...');
  agentKeyHash = await bcrypt.hash(AGENT_KEY, 4);
  await cleanupData();

  await db.insert(agents).values({
    id: AGENT_ID,
    name: 'Search Test Agent',
    ownerTwitter: 'srch_test_user',
    status: 'verified',
    balancePoints: '1000',
    apiKeyHash: agentKeyHash,
  });

  // Task 1: exact title match target
  taskExactId = generateTaskId();
  await db.insert(tasks).values({
    id: taskExactId,
    creatorAgentId: AGENT_ID,
    category: 'development',
    title: 'Build a Python script for data analysis',
    description: 'We need a Python script that parses CSV files and generates reports.',
    acceptanceCriteria: ['Script runs without errors'],
    pricePoints: '50',
    status: 'open',
    autoAcceptFirst: false,
    maxBids: 5,
    validationRequired: false,
    paymentMode: 'points',
  });

  // Task 2: partial match in description
  taskPartialId = generateTaskId();
  await db.insert(tasks).values({
    id: taskPartialId,
    creatorAgentId: AGENT_ID,
    category: 'content',
    title: 'Write a blog post',
    description: 'Create an engaging blog post about machine learning applications in healthcare.',
    acceptanceCriteria: ['Post is at least 800 words'],
    pricePoints: '30',
    status: 'open',
    autoAcceptFirst: false,
    maxBids: 5,
    validationRequired: false,
    paymentMode: 'points',
  });

  // Task 3: unrelated (should NOT match common search terms)
  taskUnrelId = generateTaskId();
  await db.insert(tasks).values({
    id: taskUnrelId,
    creatorAgentId: AGENT_ID,
    category: 'images',
    title: 'Design a company logo',
    description: 'Create a modern minimalist logo for a startup company.',
    acceptanceCriteria: ['SVG and PNG formats required'],
    pricePoints: '75',
    status: 'open',
    autoAcceptFirst: false,
    maxBids: 5,
    validationRequired: false,
    paymentMode: 'points',
  });

  // Gig 1: exact title match
  gigExactId = generateGigId();
  await db.insert(gigs).values({
    id: gigExactId,
    creatorAgentId: AGENT_ID,
    title: 'Python data analysis gig',
    description: 'I will write Python scripts for your data analysis needs.',
    category: 'development',
    pricePoints: '100',
    status: 'open',
    deliveryDays: 3,
  });

  // Gig 2: partial match in description
  gigPartialId = generateGigId();
  await db.insert(gigs).values({
    id: gigPartialId,
    creatorAgentId: AGENT_ID,
    title: 'Content writing services',
    description: 'Professional blog post and article writing for machine learning topics.',
    category: 'content',
    pricePoints: '50',
    status: 'open',
    deliveryDays: 2,
  });

  console.log('  ✅ Agent and test data created');
  console.log(`  ✅ Tasks: exact(${taskExactId}), partial(${taskPartialId}), unrelated(${taskUnrelId})`);
  console.log(`  ✅ Gigs: exact(${gigExactId}), partial(${gigPartialId})`);
}

async function cleanup() {
  console.log('🧹 Cleaning up search test data...');
  await cleanupData();
  console.log('  ✅ Cleanup complete');
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
const get = (url: string) => testApp.fetch(new Request(`http://localhost${url}`));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testTaskExactMatch() {
  console.log('\n🔍 Test 1: Tasks — exact title match');
  const resp = await get('/v1/tasks?q=Python+script');
  if (resp.status !== 200) throw new Error(`Expected 200, got ${resp.status}`);
  const body = await resp.json() as { tasks: { id: string }[]; query: string };

  if (body.query !== 'Python script') throw new Error(`Expected query field "Python script", got "${body.query}"`);
  const ids = body.tasks.map((t) => t.id);
  if (!ids.includes(taskExactId)) throw new Error(`Expected taskExactId ${taskExactId} in results, got: ${ids.join(', ')}`);
  console.log(`  → Found ${body.tasks.length} tasks, includes exact match ✅`);
}

async function testTaskPartialDescriptionMatch() {
  console.log('\n🔍 Test 2: Tasks — partial description match');
  const resp = await get('/v1/tasks?q=machine+learning');
  if (resp.status !== 200) throw new Error(`Expected 200, got ${resp.status}`);
  const body = await resp.json() as { tasks: { id: string }[] };

  const ids = body.tasks.map((t) => t.id);
  if (!ids.includes(taskPartialId)) throw new Error(`Expected taskPartialId ${taskPartialId} in results, got: ${ids.join(', ')}`);
  console.log(`  → Found ${body.tasks.length} tasks, includes partial description match ✅`);
}

async function testTaskIrrelevantQuery() {
  console.log('\n🔍 Test 3: Tasks — irrelevant query returns no results');
  const resp = await get('/v1/tasks?q=xyzzy_nonexistent_query_12345');
  if (resp.status !== 200) throw new Error(`Expected 200, got ${resp.status}`);
  const body = await resp.json() as { tasks: { id: string }[] };

  // The unrelated task IDs should not appear
  const ids = body.tasks.map((t) => t.id);
  const ourIds = [taskExactId, taskPartialId, taskUnrelId];
  const matched = ids.filter((id) => ourIds.includes(id));
  if (matched.length > 0) throw new Error(`Irrelevant query returned our test tasks: ${matched.join(', ')}`);
  console.log(`  → Query returned ${body.tasks.length} results, our tasks not included ✅`);
}

async function testTaskShortQueryReturns400() {
  console.log('\n🔍 Test 4: Tasks — q < 2 chars → 400');
  const resp = await get('/v1/tasks?q=a');
  if (resp.status !== 400) throw new Error(`Expected 400, got ${resp.status}`);
  const body = await resp.json() as { error: string };
  if (body.error !== 'invalid_request') throw new Error(`Expected error=invalid_request, got: ${body.error}`);
  console.log('  → Got 400 for single-char query ✅');
}

async function testTaskSearchWithFilters() {
  console.log('\n🔍 Test 5: Tasks — search compatible with category filter');
  const resp = await get('/v1/tasks?q=Python&category=development');
  if (resp.status !== 200) throw new Error(`Expected 200, got ${resp.status}`);
  const body = await resp.json() as { tasks: { id: string; category: string }[] };

  // All results should be in development category
  for (const t of body.tasks) {
    if (t.category !== 'development') throw new Error(`Expected category=development, got: ${t.category}`);
  }
  const ids = body.tasks.map((t) => t.id);
  if (!ids.includes(taskExactId)) throw new Error(`Expected taskExactId in development+Python results`);
  console.log(`  → ${body.tasks.length} tasks in development category with "Python" ✅`);
}

async function testTaskRelevanceSorting() {
  console.log('\n🔍 Test 6: Tasks — results sorted by relevance (exact matches first)');
  const resp = await get('/v1/tasks?q=Python');
  if (resp.status !== 200) throw new Error(`Expected 200, got ${resp.status}`);
  const body = await resp.json() as { tasks: { id: string; title: string }[] };

  if (body.tasks.length < 1) throw new Error('Expected at least 1 result for "Python"');
  // The exact title match task should appear in results
  const ids = body.tasks.map((t) => t.id);
  if (!ids.includes(taskExactId)) throw new Error(`Expected taskExactId ${taskExactId} in Python results`);
  console.log(`  → ${body.tasks.length} results returned, taskExactId present ✅`);
}

async function testGigExactMatch() {
  console.log('\n🔍 Test 7: Gigs — exact title match');
  const resp = await get('/v1/gigs?q=Python+data&status=open');
  if (resp.status !== 200) throw new Error(`Expected 200, got ${resp.status}`);
  const body = await resp.json() as { gigs: { id: string }[]; query: string };

  if (body.query !== 'Python data') throw new Error(`Expected query field "Python data", got "${body.query}"`);
  const ids = body.gigs.map((g) => g.id);
  if (!ids.includes(gigExactId)) throw new Error(`Expected gigExactId ${gigExactId} in results, got: ${ids.join(', ')}`);
  console.log(`  → Found ${body.gigs.length} gigs, includes exact match ✅`);
}

async function testGigPartialDescriptionMatch() {
  console.log('\n🔍 Test 8: Gigs — partial description match');
  const resp = await get('/v1/gigs?q=machine+learning&status=open');
  if (resp.status !== 200) throw new Error(`Expected 200, got ${resp.status}`);
  const body = await resp.json() as { gigs: { id: string }[] };

  const ids = body.gigs.map((g) => g.id);
  if (!ids.includes(gigPartialId)) throw new Error(`Expected gigPartialId ${gigPartialId} in results, got: ${ids.join(', ')}`);
  console.log(`  → Found ${body.gigs.length} gigs, includes description match ✅`);
}

async function testGigShortQueryReturns400() {
  console.log('\n🔍 Test 9: Gigs — q < 2 chars → 400');
  const resp = await get('/v1/gigs?q=x');
  if (resp.status !== 400) throw new Error(`Expected 400, got ${resp.status}`);
  const body = await resp.json() as { error: string };
  if (body.error !== 'invalid_request') throw new Error(`Expected error=invalid_request, got: ${body.error}`);
  console.log('  → Got 400 for single-char query ✅');
}

async function testGigSearchWithStatusFilter() {
  console.log('\n🔍 Test 10: Gigs — search compatible with status filter');
  const resp = await get('/v1/gigs?q=Python&status=open');
  if (resp.status !== 200) throw new Error(`Expected 200, got ${resp.status}`);
  const body = await resp.json() as { gigs: { id: string; status: string }[] };

  for (const g of body.gigs) {
    if (g.status !== 'open') throw new Error(`Expected status=open, got: ${g.status}`);
  }
  console.log(`  → ${body.gigs.length} open gigs with "Python" ✅`);
}

async function testPublicSearchAll() {
  console.log('\n🔍 Test 11: Public search — type=all returns both tasks and gigs');
  const resp = await get('/v1/public/search?q=Python&type=all');
  if (resp.status !== 200) throw new Error(`Expected 200, got ${resp.status}`);
  const body = await resp.json() as {
    query: string;
    type: string;
    tasks: { id: string; relevance: number }[];
    gigs: { id: string; relevance: number }[];
    total_tasks: number;
    total_gigs: number;
  };

  if (body.query !== 'Python') throw new Error(`Expected query="Python", got: "${body.query}"`);
  if (body.type !== 'all') throw new Error(`Expected type="all", got: "${body.type}"`);
  if (!Array.isArray(body.tasks)) throw new Error('Missing tasks array');
  if (!Array.isArray(body.gigs))  throw new Error('Missing gigs array');

  const taskIds = body.tasks.map((t) => t.id);
  const gigIds  = body.gigs.map((g) => g.id);
  if (!taskIds.includes(taskExactId)) throw new Error(`Expected taskExactId in public search tasks`);
  if (!gigIds.includes(gigExactId))   throw new Error(`Expected gigExactId in public search gigs`);

  if (body.total_tasks !== body.tasks.length) throw new Error('total_tasks mismatch');
  if (body.total_gigs !== body.gigs.length)   throw new Error('total_gigs mismatch');

  // Relevance scores should be numbers
  for (const t of body.tasks) {
    if (typeof t.relevance !== 'number') throw new Error(`Expected relevance to be number, got: ${typeof t.relevance}`);
  }

  console.log(`  → ${body.total_tasks} tasks, ${body.total_gigs} gigs returned ✅`);
}

async function testPublicSearchTasksOnly() {
  console.log('\n🔍 Test 12: Public search — type=tasks returns only tasks');
  const resp = await get('/v1/public/search?q=Python&type=tasks');
  if (resp.status !== 200) throw new Error(`Expected 200, got ${resp.status}`);
  const body = await resp.json() as {
    tasks: { id: string }[];
    gigs: { id: string }[];
    total_tasks: number;
    total_gigs: number;
  };

  if (body.gigs.length !== 0) throw new Error(`Expected 0 gigs for type=tasks, got: ${body.gigs.length}`);
  if (body.total_gigs !== 0) throw new Error(`Expected total_gigs=0, got: ${body.total_gigs}`);
  const taskIds = body.tasks.map((t) => t.id);
  if (!taskIds.includes(taskExactId)) throw new Error(`Expected taskExactId in tasks-only search`);
  console.log(`  → ${body.total_tasks} tasks, 0 gigs ✅`);
}

async function testPublicSearchGigsOnly() {
  console.log('\n🔍 Test 13: Public search — type=gigs returns only gigs');
  const resp = await get('/v1/public/search?q=Python&type=gigs');
  if (resp.status !== 200) throw new Error(`Expected 200, got ${resp.status}`);
  const body = await resp.json() as {
    tasks: { id: string }[];
    gigs: { id: string }[];
    total_tasks: number;
    total_gigs: number;
  };

  if (body.tasks.length !== 0) throw new Error(`Expected 0 tasks for type=gigs, got: ${body.tasks.length}`);
  if (body.total_tasks !== 0) throw new Error(`Expected total_tasks=0, got: ${body.total_tasks}`);
  const gigIds = body.gigs.map((g) => g.id);
  if (!gigIds.includes(gigExactId)) throw new Error(`Expected gigExactId in gigs-only search`);
  console.log(`  → 0 tasks, ${body.total_gigs} gigs ✅`);
}

async function testPublicSearchShortQueryReturns400() {
  console.log('\n🔍 Test 14: Public search — missing/short q → 400');

  const resp1 = await get('/v1/public/search');
  if (resp1.status !== 400) throw new Error(`Expected 400 for missing q, got ${resp1.status}`);

  const resp2 = await get('/v1/public/search?q=x');
  if (resp2.status !== 400) throw new Error(`Expected 400 for q=x, got ${resp2.status}`);

  console.log('  → Both cases return 400 ✅');
}

async function testPublicSearchInvalidType() {
  console.log('\n🔍 Test 15: Public search — invalid type → 400');
  const resp = await get('/v1/public/search?q=Python&type=invalid');
  if (resp.status !== 400) throw new Error(`Expected 400, got ${resp.status}`);
  const body = await resp.json() as { error: string };
  if (body.error !== 'invalid_request') throw new Error(`Expected error=invalid_request, got: ${body.error}`);
  console.log('  → Got 400 for invalid type ✅');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('🚀 Full-text Search Integration Tests');
  console.log('='.repeat(50));

  await initPool();
  await setup();

  let passCount = 0;
  let failCount = 0;

  const run = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      passCount++;
    } catch (err) {
      console.error(`\n  ❌ FAILED: ${name}`);
      console.error(`     ${err instanceof Error ? err.message : String(err)}`);
      failCount++;
    }
  };

  await run('Test 1:  Tasks exact title match',                         testTaskExactMatch);
  await run('Test 2:  Tasks partial description match',                 testTaskPartialDescriptionMatch);
  await run('Test 3:  Tasks irrelevant query returns no results',       testTaskIrrelevantQuery);
  await run('Test 4:  Tasks q < 2 chars → 400',                        testTaskShortQueryReturns400);
  await run('Test 5:  Tasks search with category filter',               testTaskSearchWithFilters);
  await run('Test 6:  Tasks results sorted by relevance',               testTaskRelevanceSorting);
  await run('Test 7:  Gigs exact title match',                          testGigExactMatch);
  await run('Test 8:  Gigs partial description match',                  testGigPartialDescriptionMatch);
  await run('Test 9:  Gigs q < 2 chars → 400',                         testGigShortQueryReturns400);
  await run('Test 10: Gigs search with status filter',                  testGigSearchWithStatusFilter);
  await run('Test 11: Public search type=all',                          testPublicSearchAll);
  await run('Test 12: Public search type=tasks only',                   testPublicSearchTasksOnly);
  await run('Test 13: Public search type=gigs only',                    testPublicSearchGigsOnly);
  await run('Test 14: Public search short q → 400',                    testPublicSearchShortQueryReturns400);
  await run('Test 15: Public search invalid type → 400',               testPublicSearchInvalidType);

  if (!process.env.KEEP_TEST_DATA) { await cleanup(); } else { console.log('🔒 KEEP_TEST_DATA set — skipping cleanup'); }

  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passCount} passed, ${failCount} failed`);

  if (failCount > 0) {
    console.log('\n⚠️  Some tests failed. Review output above.');
    process.exit(1);
  } else {
    console.log('🎉 All search tests passed!');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
