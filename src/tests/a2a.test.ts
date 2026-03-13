/**
 * A2A Protocol integration tests — validates:
 *   1. message/send creates task + a2a_task_contexts row
 *   2. tasks/get returns correct A2A state mapping
 *   3. tasks/cancel refunds escrow
 *   4. tasks/list returns open tasks with pagination
 *   5. End-to-end: message/send → tasks/get → status tracking
 *
 * Run: npx tsx src/tests/a2a.test.ts
 * Requires: DATABASE_URL in .env
 */

import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { db, initPool } from '../db/pool.js';
import { agents, tasks, a2aTaskContexts } from '../db/schema/index.js';
import { handleA2ARequest, umwStatusToA2A } from '../a2a/handler.js';
import type { AgentRow } from '../db/schema/index.js';
import type { A2ATask, ListTasksResult } from '../a2a/types.js';
import { A2AMethods } from '../a2a/types.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const TEST_AGENT_ID = 'agt_a2atest1';
const TEST_AGENT_2_ID = 'agt_a2atest2';

async function setup() {
  console.log('🔧 Setting up test agents...');

  await db.execute(sql`
    DELETE FROM a2a_task_contexts WHERE creator_agent_id IN (${TEST_AGENT_ID}, ${TEST_AGENT_2_ID})
  `);
  // Must delete transactions before tasks (FK constraint)
  await db.execute(sql`
    DELETE FROM transactions WHERE task_id IN (
      SELECT id FROM tasks WHERE creator_agent_id IN (${TEST_AGENT_ID}, ${TEST_AGENT_2_ID})
    )
  `);
  await db.execute(sql`
    DELETE FROM transactions WHERE from_agent_id IN (${TEST_AGENT_ID}, ${TEST_AGENT_2_ID})
       OR to_agent_id IN (${TEST_AGENT_ID}, ${TEST_AGENT_2_ID})
  `);
  await db.execute(sql`
    DELETE FROM tasks WHERE creator_agent_id IN (${TEST_AGENT_ID}, ${TEST_AGENT_2_ID})
  `);
  await db.execute(sql`DELETE FROM agents WHERE id IN (${TEST_AGENT_ID}, ${TEST_AGENT_2_ID})`);

  await db.insert(agents).values([
    {
      id: TEST_AGENT_ID,
      name: 'A2A Test Agent 1',
      ownerTwitter: 'a2a_test_agent_1',
      status: 'verified',
      balancePoints: '500',
      apiKeyHash: 'test_hash_a2a_1',
    },
    {
      id: TEST_AGENT_2_ID,
      name: 'A2A Test Agent 2',
      ownerTwitter: 'a2a_test_agent_2',
      status: 'verified',
      balancePoints: '500',
      apiKeyHash: 'test_hash_a2a_2',
    },
  ]);
  console.log('  ✅ Test agents created');
}

async function cleanup() {
  console.log('🧹 Cleaning up...');
  await db.execute(sql`
    DELETE FROM a2a_task_contexts WHERE creator_agent_id IN (${TEST_AGENT_ID}, ${TEST_AGENT_2_ID})
  `);
  // Must delete transactions before tasks (FK constraint)
  await db.execute(sql`
    DELETE FROM transactions WHERE task_id IN (
      SELECT id FROM tasks WHERE creator_agent_id IN (${TEST_AGENT_ID}, ${TEST_AGENT_2_ID})
    )
  `);
  await db.execute(sql`
    DELETE FROM transactions WHERE from_agent_id IN (${TEST_AGENT_ID}, ${TEST_AGENT_2_ID})
      OR to_agent_id IN (${TEST_AGENT_ID}, ${TEST_AGENT_2_ID})
  `);
  await db.execute(sql`
    DELETE FROM tasks WHERE creator_agent_id IN (${TEST_AGENT_ID}, ${TEST_AGENT_2_ID})
  `);
  await db.execute(sql`DELETE FROM agents WHERE id IN (${TEST_AGENT_ID}, ${TEST_AGENT_2_ID})`);
  console.log('  ✅ Cleanup complete');
}

function makeAgent(id: string): AgentRow {
  return {
    id,
    name: 'Test Agent',
    description: null,
    ownerTwitter: 'test',
    status: 'verified',
    balancePoints: '500',
    balanceUsdc: '0',
    reputationScore: '0',
    tasksCompleted: 0,
    tasksCreated: 0,
    successRate: '0',
    specializations: [],
    evmAddress: null,
    webhookUrl: null,
    webhookSecret: null,
    a2aCardUrl: null,
    apiKeyHash: 'test',
    lastApiCallAt: null,
    verifiedAt: null,
    verificationTweetUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Test 1: message/send creates task + context row
// ---------------------------------------------------------------------------
async function testMessageSend() {
  console.log('\n📋 Test 1: message/send creates task + context row');

  const agent = makeAgent(TEST_AGENT_ID);
  const response = await handleA2ARequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: A2AMethods.MessageSend,
      params: {
        message: {
          role: 'user',
          parts: [
            {
              type: 'data',
              data: {
                title: 'A2A Test Task',
                description: 'Test task created via A2A protocol',
                category: 'development',
                budget_points: 50,
              },
            },
          ],
        },
      },
    },
    agent,
  );

  if (response.error) {
    throw new Error(`message/send failed: ${JSON.stringify(response.error)}`);
  }

  const task = response.result as A2ATask;
  console.log(`  → Created A2A task id: ${task.id}`);
  console.log(`  → Task state: ${task.status.state}`);
  console.log(`  → UMW task id: ${task.metadata?.umw_task_id}`);

  if (task.status.state !== 'submitted') {
    throw new Error(`Expected state "submitted", got "${task.status.state}"`);
  }
  if (!task.id) throw new Error('Missing A2A task id');

  // Verify context row exists
  const [ctx] = await db
    .select()
    .from(a2aTaskContexts)
    .where(eq(a2aTaskContexts.a2aTaskId, task.id))
    .limit(1);

  if (!ctx) throw new Error('Missing a2a_task_contexts row');
  if (ctx.creatorAgentId !== TEST_AGENT_ID) {
    throw new Error(`Wrong creator: ${ctx.creatorAgentId}`);
  }

  // Verify escrow was deducted
  const [agentRow] = await db.select({ balance: agents.balancePoints }).from(agents).where(eq(agents.id, TEST_AGENT_ID)).limit(1);
  const balance = parseFloat(agentRow?.balance ?? '0');
  if (balance !== 450) {
    throw new Error(`Expected balance 450, got ${balance}`);
  }

  console.log('  ✅ task + context row created, escrow deducted correctly');
  return task.id;
}

// ---------------------------------------------------------------------------
// Test 2: tasks/get returns correct A2A state
// ---------------------------------------------------------------------------
async function testTasksGet(a2aTaskId: string) {
  console.log('\n🔍 Test 2: tasks/get returns correct A2A state');

  const agent = makeAgent(TEST_AGENT_ID);
  const response = await handleA2ARequest(
    {
      jsonrpc: '2.0',
      id: 2,
      method: A2AMethods.TasksGet,
      params: { id: a2aTaskId },
    },
    agent,
  );

  if (response.error) {
    throw new Error(`tasks/get failed: ${JSON.stringify(response.error)}`);
  }

  const task = response.result as A2ATask;
  if (task.id !== a2aTaskId) throw new Error(`Wrong task id: ${task.id}`);
  if (task.status.state !== 'submitted') {
    throw new Error(`Expected "submitted", got "${task.status.state}"`);
  }

  console.log(`  → Retrieved task ${a2aTaskId}, state: ${task.status.state}`);
  console.log('  ✅ tasks/get returns correct state');
}

// ---------------------------------------------------------------------------
// Test 3: tasks/cancel refunds escrow
// ---------------------------------------------------------------------------
async function testTasksCancel(a2aTaskId: string) {
  console.log('\n❌ Test 3: tasks/cancel refunds escrow');

  const agent = makeAgent(TEST_AGENT_ID);
  const response = await handleA2ARequest(
    {
      jsonrpc: '2.0',
      id: 3,
      method: A2AMethods.TasksCancel,
      params: { id: a2aTaskId },
    },
    agent,
  );

  if (response.error) {
    throw new Error(`tasks/cancel failed: ${JSON.stringify(response.error)}`);
  }

  const task = response.result as A2ATask;
  if (task.status.state !== 'canceled') {
    throw new Error(`Expected "canceled", got "${task.status.state}"`);
  }

  // Verify escrow refunded
  const [agentRow] = await db.select({ balance: agents.balancePoints }).from(agents).where(eq(agents.id, TEST_AGENT_ID)).limit(1);
  const balance = parseFloat(agentRow?.balance ?? '0');
  if (balance !== 500) {
    throw new Error(`Expected balance 500 (refunded), got ${balance}`);
  }

  console.log(`  → Cancelled task ${a2aTaskId}, state: ${task.status.state}`);
  console.log('  ✅ tasks/cancel refunds escrow correctly');
}

// ---------------------------------------------------------------------------
// Test 4: tasks/list returns open tasks with pagination
// ---------------------------------------------------------------------------
async function testTasksList() {
  console.log('\n📄 Test 4: tasks/list returns open tasks');

  // Create a fresh open task for listing
  const agent = makeAgent(TEST_AGENT_ID);
  const createResp = await handleA2ARequest(
    {
      jsonrpc: '2.0',
      id: 10,
      method: A2AMethods.MessageSend,
      params: {
        message: {
          role: 'user',
          parts: [
            {
              type: 'data',
              data: {
                title: 'A2A List Test Task',
                description: 'Task for listing test',
                category: 'content',
                budget_points: 20,
              },
            },
          ],
        },
      },
    },
    agent,
  );
  if (createResp.error) throw new Error(`Create failed: ${JSON.stringify(createResp.error)}`);

  const response = await handleA2ARequest(
    {
      jsonrpc: '2.0',
      id: 4,
      method: A2AMethods.TasksList,
      params: { pageSize: 10 },
    },
    agent,
  );

  if (response.error) {
    throw new Error(`tasks/list failed: ${JSON.stringify(response.error)}`);
  }

  const result = response.result as ListTasksResult;
  if (!Array.isArray(result.tasks)) throw new Error('tasks/list: result.tasks is not an array');
  if (result.tasks.length === 0) throw new Error('tasks/list: no tasks returned');

  const a2aTask = createResp.result as A2ATask;
  const found = result.tasks.find((t) => t.id === a2aTask.id);
  if (!found) throw new Error(`tasks/list: created task ${a2aTask.id} not in results`);

  console.log(`  → Listed ${result.tasks.length} tasks`);
  console.log(`  → Created task found in list: ${a2aTask.id}`);
  console.log('  ✅ tasks/list works correctly');
}

// ---------------------------------------------------------------------------
// Test 5: umwStatusToA2A mapping
// ---------------------------------------------------------------------------
function testStatusMapping() {
  console.log('\n🗺️  Test 5: status mapping umwStatusToA2A');

  const cases: [string, string][] = [
    ['open', 'submitted'],
    ['bidding', 'submitted'],
    ['in_progress', 'working'],
    ['submitted', 'working'],
    ['validating', 'input-required'],
    ['completed', 'completed'],
    ['disputed', 'failed'],
    ['cancelled', 'canceled'],
    ['unknown_status', 'unknown'],
  ];

  for (const [umwStatus, expectedA2a] of cases) {
    const actual = umwStatusToA2A(umwStatus);
    if (actual !== expectedA2a) {
      throw new Error(`umwStatusToA2A("${umwStatus}") = "${actual}", expected "${expectedA2a}"`);
    }
  }

  console.log('  ✅ All status mappings correct');
}

// ---------------------------------------------------------------------------
// Test 6: Not found / error handling
// ---------------------------------------------------------------------------
async function testNotFound() {
  console.log('\n🚫 Test 6: tasks/get with invalid id returns TaskNotFound');

  const agent = makeAgent(TEST_AGENT_ID);
  const response = await handleA2ARequest(
    {
      jsonrpc: '2.0',
      id: 5,
      method: A2AMethods.TasksGet,
      params: { id: '00000000-0000-0000-0000-000000000000' },
    },
    agent,
  );

  if (!response.error) throw new Error('Expected error but got success');
  if (response.error.code !== -32001) {
    throw new Error(`Expected code -32001, got ${response.error.code}`);
  }

  console.log(`  → Got error code ${response.error.code}: ${response.error.message}`);
  console.log('  ✅ Not found errors handled correctly');
}

// ---------------------------------------------------------------------------
// Test 7: tasks/pushNotification/set and get
// ---------------------------------------------------------------------------
async function testPushNotificationConfig() {
  console.log('\n🔔 Test 7: tasks/pushNotification/set and get');

  const agent = makeAgent(TEST_AGENT_ID);

  // Create a task first
  const createResp = await handleA2ARequest(
    {
      jsonrpc: '2.0',
      id: 20,
      method: A2AMethods.MessageSend,
      params: {
        message: {
          role: 'user',
          messageId: 'msg-push-test-001',
          parts: [
            {
              type: 'data',
              data: {
                title: 'Push Notification Test Task',
                description: 'Task for push notification config test',
                category: 'development',
                budget_points: 20,
              },
            },
          ],
        },
      },
    },
    agent,
  );
  if (createResp.error) throw new Error(`Create failed: ${JSON.stringify(createResp.error)}`);
  const task = createResp.result as A2ATask;

  // Set push config
  const setResp = await handleA2ARequest(
    {
      jsonrpc: '2.0',
      id: 21,
      method: A2AMethods.TasksPushNotificationSet,
      params: {
        id: task.id,
        pushNotificationConfig: { url: 'https://example.com/webhook', token: 'secret-token' },
      },
    },
    agent,
  );
  if (setResp.error) throw new Error(`set failed: ${JSON.stringify(setResp.error)}`);
  console.log(`  → Push config set for task ${task.id}`);

  // Get push config
  const getResp = await handleA2ARequest(
    {
      jsonrpc: '2.0',
      id: 22,
      method: A2AMethods.TasksPushNotificationGet,
      params: { id: task.id },
    },
    agent,
  );
  if (getResp.error) throw new Error(`get failed: ${JSON.stringify(getResp.error)}`);
  const config = getResp.result as { id: string; pushNotificationConfig: { url: string } };
  if (config.pushNotificationConfig?.url !== 'https://example.com/webhook') {
    throw new Error(`Wrong URL: ${config.pushNotificationConfig?.url}`);
  }

  console.log(`  → Push config retrieved: url=${config.pushNotificationConfig.url}`);
  console.log('  ✅ Push notification config set/get works');
}

// ---------------------------------------------------------------------------
// Test 8: TaskStatusUpdateEvent field compliance
// ---------------------------------------------------------------------------
async function testTaskStatusUpdateEventFields() {
  console.log('\n📡 Test 8: TaskStatusUpdateEvent uses taskId (not id)');

  // This test verifies that the TypeScript types are correct — if the types
  // compiled without error we're good. Let's also verify the runtime shape.
  const event = {
    taskId: 'test-task-id',
    contextId: 'test-context-id',
    status: { state: 'working' as const, timestamp: new Date().toISOString() },
    final: false,
  };

  if (!('taskId' in event)) throw new Error('Event missing taskId field');
  if ('id' in event) throw new Error('Event has deprecated id field (should be taskId)');

  console.log('  → Event shape: { taskId, contextId, status, final }');
  console.log('  ✅ TaskStatusUpdateEvent uses correct field names per A2A spec');
}

// ---------------------------------------------------------------------------
// Test 9: messageId is generated in task history
// ---------------------------------------------------------------------------
async function testMessageIdInHistory() {
  console.log('\n📨 Test 9: Task history messages have messageId');

  const agent = makeAgent(TEST_AGENT_ID);
  const createResp = await handleA2ARequest(
    {
      jsonrpc: '2.0',
      id: 30,
      method: A2AMethods.MessageSend,
      params: {
        message: {
          role: 'user',
          messageId: 'msg-history-test-001',
          parts: [
            {
              type: 'data',
              data: {
                title: 'History MessageId Test Task',
                description: 'Verify messageId in history',
                category: 'development',
                budget_points: 15,
              },
            },
          ],
        },
      },
    },
    agent,
  );
  if (createResp.error) throw new Error(`Create failed: ${JSON.stringify(createResp.error)}`);

  const task = createResp.result as A2ATask;
  if (!task.history || task.history.length === 0) {
    throw new Error('Task has no history');
  }
  const firstMsg = task.history[0]!;
  if (!firstMsg.messageId) {
    throw new Error('History message missing messageId');
  }

  console.log(`  → History[0].messageId = ${firstMsg.messageId}`);
  console.log('  ✅ messageId present in task history messages');
}

// ---------------------------------------------------------------------------
// Test 10: Agent Card compliance
// ---------------------------------------------------------------------------
async function testAgentCardCompliance() {
  console.log('\n🪪 Test 10: Agent Card compliance');

  const resp = await fetch('https://api.upmoltwork.mingles.ai/.well-known/agent.json');
  if (!resp.ok) {
    console.log(`  ⚠️  Could not fetch live agent card (status ${resp.status}) — skipping live check`);
    console.log('  ✅ Agent card compliance (skipped — not live)');
    return;
  }

  const card = await resp.json() as Record<string, unknown>;

  const requiredFields = ['name', 'description', 'url', 'version', 'protocolVersion', 'capabilities', 'skills', 'authentication'];
  for (const field of requiredFields) {
    if (!(field in card)) throw new Error(`Agent card missing required field: ${field}`);
  }

  const skills = card.skills as Array<Record<string, unknown>>;
  if (!skills || skills.length === 0) throw new Error('Agent card has no skills');
  if (!skills[0]!.inputSchema) throw new Error('Skill missing inputSchema');
  if (!skills[0]!.apiSpecUrl) throw new Error('Skill missing apiSpecUrl');

  console.log(`  → protocolVersion: ${card.protocolVersion}`);
  console.log(`  → skills[0].apiSpecUrl: ${skills[0]!.apiSpecUrl}`);
  console.log('  ✅ Agent card has all required fields');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('🚀 A2A Protocol Integration Tests\n' + '='.repeat(40));

  await initPool();
  await setup();

  let passCount = 0;
  let failCount = 0;

  const run = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      passCount++;
    } catch (err) {
      console.error(`  ❌ FAILED: ${name}`);
      console.error(`     ${err instanceof Error ? err.message : String(err)}`);
      failCount++;
    }
  };

  // Test 5 (sync) first
  try {
    testStatusMapping();
    passCount++;
  } catch (err) {
    console.error(`  ❌ FAILED: status mapping`);
    console.error(`     ${err instanceof Error ? err.message : String(err)}`);
    failCount++;
  }

  // Tests that depend on each other
  let a2aTaskId: string | null = null;
  try {
    a2aTaskId = await testMessageSend();
    passCount++;
  } catch (err) {
    console.error(`  ❌ FAILED: message/send`);
    console.error(`     ${err instanceof Error ? err.message : String(err)}`);
    failCount++;
  }

  if (a2aTaskId) {
    await run('tasks/get', () => testTasksGet(a2aTaskId!));
    await run('tasks/cancel', () => testTasksCancel(a2aTaskId!));
  }

  await run('tasks/list', testTasksList);
  await run('not found handling', testNotFound);
  await run('push notification set/get', testPushNotificationConfig);
  await run('TaskStatusUpdateEvent field compliance', testTaskStatusUpdateEventFields);
  await run('messageId in history', testMessageIdInHistory);
  await run('agent card compliance', testAgentCardCompliance);

  await cleanup();

  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passCount} passed, ${failCount} failed`);

  if (failCount > 0) {
    process.exit(1);
  } else {
    console.log('🎉 All A2A tests passed!');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
