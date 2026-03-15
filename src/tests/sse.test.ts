/**
 * SSE (Server-Sent Events) unit tests for A2A tasks/subscribe.
 *
 * Tests the in-process EventEmitter (`sseEmitter`) without an HTTP server.
 * Verifies that:
 *   1. emitTaskStatus delivers payloads to registered listeners
 *   2. Multiple listeners can coexist for different tasks
 *   3. Terminal state events carry final=true
 *   4. Listener cleanup works (off)
 *   5. Integration smoke: notifyA2AStatus emits via sseEmitter
 *
 * Run: npx tsx src/tests/sse.test.ts
 * No DATABASE_URL required — pure unit tests.
 */

import { sseEmitter, emitTaskStatus, taskStatusEvent, type TaskStatusPayload } from '../a2a/sse.js';
import { notifyA2AStatus } from '../a2a/push.js';
import type { A2ATaskContextRow } from '../db/schema/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passCount = 0;
let failCount = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passCount++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err instanceof Error ? err.message : String(err)}`);
    failCount++;
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function waitForEvent(
  emitter: typeof sseEmitter,
  event: string,
  timeoutMs = 1000,
): Promise<TaskStatusPayload> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for event: ${event}`)), timeoutMs);
    emitter.once(event, (payload: TaskStatusPayload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

// ---------------------------------------------------------------------------
// Test 1: emitTaskStatus delivers payload to listener
// ---------------------------------------------------------------------------
async function testBasicEmit() {
  const a2aTaskId = 'test-task-sse-001';
  const eventName = taskStatusEvent(a2aTaskId);

  const payloadPromise = waitForEvent(sseEmitter, eventName);

  emitTaskStatus({
    a2aTaskId,
    state: 'working',
    timestamp: new Date().toISOString(),
    final: false,
    contextId: 'ctx-001',
  });

  const received = await payloadPromise;
  assert(received.a2aTaskId === a2aTaskId, `taskId mismatch: ${received.a2aTaskId}`);
  assert(received.state === 'working', `state mismatch: ${received.state}`);
  assert(received.final === false, `final should be false`);
  assert(received.contextId === 'ctx-001', `contextId mismatch`);
}

// ---------------------------------------------------------------------------
// Test 2: Terminal state emits final=true
// ---------------------------------------------------------------------------
async function testTerminalEmit() {
  const a2aTaskId = 'test-task-sse-002';
  const eventName = taskStatusEvent(a2aTaskId);

  const payloadPromise = waitForEvent(sseEmitter, eventName);

  emitTaskStatus({
    a2aTaskId,
    state: 'completed',
    timestamp: new Date().toISOString(),
    final: true,
  });

  const received = await payloadPromise;
  assert(received.state === 'completed', `state mismatch: ${received.state}`);
  assert(received.final === true, `final should be true for completed`);
}

// ---------------------------------------------------------------------------
// Test 3: Multiple listeners for different tasks don't cross-fire
// ---------------------------------------------------------------------------
async function testIsolation() {
  const task1 = 'test-task-sse-iso-001';
  const task2 = 'test-task-sse-iso-002';

  const received1: TaskStatusPayload[] = [];
  const received2: TaskStatusPayload[] = [];

  const listener1 = (p: TaskStatusPayload) => received1.push(p);
  const listener2 = (p: TaskStatusPayload) => received2.push(p);

  sseEmitter.on(taskStatusEvent(task1), listener1);
  sseEmitter.on(taskStatusEvent(task2), listener2);

  emitTaskStatus({ a2aTaskId: task1, state: 'working', timestamp: new Date().toISOString(), final: false });
  emitTaskStatus({ a2aTaskId: task2, state: 'completed', timestamp: new Date().toISOString(), final: true });
  emitTaskStatus({ a2aTaskId: task1, state: 'completed', timestamp: new Date().toISOString(), final: true });

  // Give synchronous emits a tick to propagate
  await new Promise((r) => setTimeout(r, 10));

  sseEmitter.off(taskStatusEvent(task1), listener1);
  sseEmitter.off(taskStatusEvent(task2), listener2);

  assert(received1.length === 2, `task1 should have 2 events, got ${received1.length}`);
  assert(received2.length === 1, `task2 should have 1 event, got ${received2.length}`);
  assert(received1[0]!.state === 'working', `task1[0] should be working`);
  assert(received1[1]!.state === 'completed', `task1[1] should be completed`);
  assert(received2[0]!.state === 'completed', `task2[0] should be completed`);
}

// ---------------------------------------------------------------------------
// Test 4: Listener cleanup (off) — no events after removal
// ---------------------------------------------------------------------------
async function testListenerCleanup() {
  const a2aTaskId = 'test-task-sse-cleanup';
  const received: TaskStatusPayload[] = [];
  const listener = (p: TaskStatusPayload) => received.push(p);

  sseEmitter.on(taskStatusEvent(a2aTaskId), listener);

  // First emit — should be received
  emitTaskStatus({ a2aTaskId, state: 'working', timestamp: new Date().toISOString(), final: false });
  await new Promise((r) => setTimeout(r, 10));

  // Remove listener
  sseEmitter.off(taskStatusEvent(a2aTaskId), listener);

  // Second emit — should NOT be received
  emitTaskStatus({ a2aTaskId, state: 'completed', timestamp: new Date().toISOString(), final: true });
  await new Promise((r) => setTimeout(r, 10));

  assert(received.length === 1, `Should have 1 event after cleanup, got ${received.length}`);
  assert(received[0]!.state === 'working', `First event should be working`);
}

// ---------------------------------------------------------------------------
// Test 5: taskStatusEvent returns consistent event name
// ---------------------------------------------------------------------------
function testEventNameFormat() {
  const id = 'abc-123';
  const name = taskStatusEvent(id);
  assert(name === 'task:status:abc-123', `Event name format wrong: ${name}`);
}

// ---------------------------------------------------------------------------
// Test 6: notifyA2AStatus emits SSE (no webhook configured)
// ---------------------------------------------------------------------------
async function testNotifyA2AStatusEmitsSSE() {
  const a2aTaskId = 'test-task-notify-sse-001';

  // Fake context row with no webhook
  const fakeCtx = {
    a2aTaskId,
    umwTaskId: 'umw-task-001',
    contextId: 'ctx-notify-001',
    creatorAgentId: 'agt_test',
    pushWebhookUrl: null,
    pushToken: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as A2ATaskContextRow;

  const payloadPromise = waitForEvent(sseEmitter, taskStatusEvent(a2aTaskId));

  notifyA2AStatus(fakeCtx, {
    taskId: a2aTaskId,
    contextId: 'ctx-notify-001',
    status: { state: 'working', timestamp: new Date().toISOString() },
    final: false,
  });

  const received = await payloadPromise;
  assert(received.a2aTaskId === a2aTaskId, `taskId mismatch: ${received.a2aTaskId}`);
  assert(received.state === 'working', `state mismatch: ${received.state}`);
  assert(received.contextId === 'ctx-notify-001', `contextId mismatch`);
}

// ---------------------------------------------------------------------------
// Test 7: Multiple concurrent listeners on same task
// ---------------------------------------------------------------------------
async function testMultipleListeners() {
  const a2aTaskId = 'test-task-sse-multi';
  const r1: TaskStatusPayload[] = [];
  const r2: TaskStatusPayload[] = [];
  const r3: TaskStatusPayload[] = [];

  const l1 = (p: TaskStatusPayload) => r1.push(p);
  const l2 = (p: TaskStatusPayload) => r2.push(p);
  const l3 = (p: TaskStatusPayload) => r3.push(p);

  sseEmitter.on(taskStatusEvent(a2aTaskId), l1);
  sseEmitter.on(taskStatusEvent(a2aTaskId), l2);
  sseEmitter.on(taskStatusEvent(a2aTaskId), l3);

  emitTaskStatus({ a2aTaskId, state: 'submitted', timestamp: new Date().toISOString(), final: false });
  await new Promise((r) => setTimeout(r, 10));

  sseEmitter.off(taskStatusEvent(a2aTaskId), l1);
  sseEmitter.off(taskStatusEvent(a2aTaskId), l2);
  sseEmitter.off(taskStatusEvent(a2aTaskId), l3);

  assert(r1.length === 1, `listener1 should get 1 event`);
  assert(r2.length === 1, `listener2 should get 1 event`);
  assert(r3.length === 1, `listener3 should get 1 event`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('🌊 SSE EventEmitter Unit Tests\n' + '='.repeat(40));

  await test('basic emit delivers payload', testBasicEmit);
  await test('terminal state has final=true', testTerminalEmit);
  await test('listeners are isolated by taskId', testIsolation);
  await test('listener cleanup prevents further events', testListenerCleanup);
  test('taskStatusEvent name format', testEventNameFormat);
  await test('notifyA2AStatus emits SSE without webhook', testNotifyA2AStatusEmitsSSE);
  await test('multiple concurrent listeners on same task', testMultipleListeners);

  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passCount} passed, ${failCount} failed`);

  if (failCount > 0) process.exit(1);
  else console.log('🎉 All SSE tests passed!');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
