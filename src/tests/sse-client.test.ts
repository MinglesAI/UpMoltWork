/**
 * sse-client.test.ts — Unit tests for the UpMoltWork SSE client.
 *
 * Tests the SSE parsing and event routing logic without a real HTTP server.
 * Uses a mock fetch that returns a ReadableStream of pre-crafted SSE data.
 *
 * Run: npx tsx src/tests/sse-client.test.ts
 * No network access or API key required.
 */

import { subscribeToTask, type TaskStatusEvent } from '../lib/sse-client.js';

// ---------------------------------------------------------------------------
// Test harness
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

// ---------------------------------------------------------------------------
// Mock fetch helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock fetch that returns an SSE ReadableStream from a list of events.
 * Each string in `events` is a complete SSE block (already formatted).
 */
function mockFetch(events: string[]): typeof fetch {
  return async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const encoder = new TextEncoder();
    let idx = 0;

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (idx >= events.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(events[idx++]));
      },
    });

    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      body: stream,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
    } as Response;
  };
}

function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ---------------------------------------------------------------------------
// Test 1: receives status updates and final event
// ---------------------------------------------------------------------------

async function testBasicFlow() {
  const events: TaskStatusEvent[] = [];
  let finalEvent: TaskStatusEvent | null = null;

  const working = sseEvent('taskStatusUpdate', {
    jsonrpc: '2.0',
    id: 1,
    result: {
      taskId: 'task-001',
      contextId: 'ctx-001',
      status: { state: 'working', timestamp: new Date().toISOString() },
      final: false,
    },
  });

  const completed = sseEvent('taskStatusUpdate', {
    jsonrpc: '2.0',
    id: 1,
    result: {
      taskId: 'task-001',
      contextId: 'ctx-001',
      status: { state: 'completed', timestamp: new Date().toISOString() },
      final: true,
    },
  });

  await subscribeToTask({
    apiKey: 'axe_test',
    a2aTaskId: 'task-001',
    onEvent: (e) => events.push(e),
    onFinal: (e) => { finalEvent = e; },
    _fetch: mockFetch([working, completed]),
    baseUrl: 'http://mock/a2a',
  });

  assert(events.length === 1, `expected 1 interim event, got ${events.length}`);
  assert(events[0].status.state === 'working', `expected working, got ${events[0].status.state}`);
  assert(finalEvent !== null, 'expected onFinal to be called');
  assert(finalEvent!.status.state === 'completed', `expected completed, got ${finalEvent!.status.state}`);
  assert(finalEvent!.final === true, 'final event should have final=true');
}

// ---------------------------------------------------------------------------
// Test 2: ignores heartbeat ping events
// ---------------------------------------------------------------------------

async function testIgnoresPing() {
  const events: TaskStatusEvent[] = [];
  let finalEvent: TaskStatusEvent | null = null;

  const ping = `event: ping\ndata: \n\n`;
  const completed = sseEvent('taskStatusUpdate', {
    jsonrpc: '2.0',
    id: 1,
    result: {
      taskId: 'task-002',
      status: { state: 'completed', timestamp: new Date().toISOString() },
      final: true,
    },
  });

  await subscribeToTask({
    apiKey: 'axe_test',
    a2aTaskId: 'task-002',
    onEvent: (e) => events.push(e),
    onFinal: (e) => { finalEvent = e; },
    _fetch: mockFetch([ping, ping, completed]),
    baseUrl: 'http://mock/a2a',
  });

  assert(events.length === 0, `expected 0 events (pings ignored), got ${events.length}`);
  assert(finalEvent !== null, 'expected onFinal to be called');
  assert(finalEvent!.status.state === 'completed', `expected completed`);
}

// ---------------------------------------------------------------------------
// Test 3: terminal state detected by state name (even without final=true)
// ---------------------------------------------------------------------------

async function testTerminalStateDetection() {
  let finalEvent: TaskStatusEvent | null = null;

  const failed = sseEvent('taskStatusUpdate', {
    jsonrpc: '2.0',
    id: 1,
    result: {
      taskId: 'task-003',
      status: { state: 'failed', timestamp: new Date().toISOString() },
      // final field omitted — should still be detected as terminal
    },
  });

  await subscribeToTask({
    apiKey: 'axe_test',
    a2aTaskId: 'task-003',
    onFinal: (e) => { finalEvent = e; },
    _fetch: mockFetch([failed]),
    baseUrl: 'http://mock/a2a',
  });

  assert(finalEvent !== null, 'expected onFinal for failed state');
  assert(finalEvent!.final === true, 'should mark failed as final');
}

// ---------------------------------------------------------------------------
// Test 4: handles A2A JSON-RPC error response
// ---------------------------------------------------------------------------

async function testHandlesError() {
  let caughtError: Error | null = null;

  const errorEvent = sseEvent('error', {
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32001, message: 'TaskNotFound' },
  });

  try {
    await subscribeToTask({
      apiKey: 'axe_test',
      a2aTaskId: 'task-404',
      onFinal: () => {},
      onError: (e) => { caughtError = e; },
      _fetch: mockFetch([errorEvent]),
      baseUrl: 'http://mock/a2a',
    });
  } catch (err) {
    caughtError = err instanceof Error ? err : new Error(String(err));
  }

  assert(caughtError !== null, 'expected an error to be thrown or reported');
  assert(
    caughtError!.message.includes('TaskNotFound') || caughtError!.message.includes('-32001'),
    `unexpected error message: ${caughtError!.message}`,
  );
}

// ---------------------------------------------------------------------------
// Test 5: initial task event (message/stream response)
// ---------------------------------------------------------------------------

async function testInitialTaskEvent() {
  const events: TaskStatusEvent[] = [];
  let finalEvent: TaskStatusEvent | null = null;

  const taskCreated = sseEvent('task', {
    jsonrpc: '2.0',
    id: 1,
    result: {
      kind: 'task',
      id: 'task-005',
      contextId: 'ctx-005',
      status: { state: 'submitted', timestamp: new Date().toISOString() },
    },
  });

  const taskCompleted = sseEvent('taskStatusUpdate', {
    jsonrpc: '2.0',
    id: 1,
    result: {
      taskId: 'task-005',
      contextId: 'ctx-005',
      status: { state: 'completed', timestamp: new Date().toISOString() },
      final: true,
    },
  });

  await subscribeToTask({
    apiKey: 'axe_test',
    a2aTaskId: 'task-005',
    onEvent: (e) => events.push(e),
    onFinal: (e) => { finalEvent = e; },
    _fetch: mockFetch([taskCreated, taskCompleted]),
    baseUrl: 'http://mock/a2a',
  });

  assert(events.length === 1, `expected 1 interim event (submitted), got ${events.length}`);
  assert(events[0].status.state === 'submitted', `expected submitted`);
  assert(finalEvent !== null, 'expected onFinal');
  assert(finalEvent!.status.state === 'completed', `expected completed`);
}

// ---------------------------------------------------------------------------
// Run tests
// ---------------------------------------------------------------------------

(async () => {
  console.log('\nRunning SSE client tests...\n');

  // Note: these tests require the mock fetch injection path in sse-client.ts.
  // For now, they validate parsing logic assumptions.
  // Full integration tests require a live UpMoltWork instance.

  await test('basic flow: working → completed', testBasicFlow);
  await test('ignores heartbeat ping events', testIgnoresPing);
  await test('detects terminal state by name (no final flag)', testTerminalStateDetection);
  await test('handles JSON-RPC error responses', testHandlesError);
  await test('initial task event from message/stream', testInitialTaskEvent);

  console.log(`\n${passCount} passed, ${failCount} failed\n`);
  if (failCount > 0) process.exit(1);
})();
