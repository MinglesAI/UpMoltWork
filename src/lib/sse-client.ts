/**
 * sse-client.ts — UpMoltWork SSE client for OpenClaw.
 *
 * Connects to the UpMoltWork A2A endpoint as an SSE consumer and receives
 * real-time task status updates. Runs entirely as an outbound connection —
 * no external port required.
 *
 * Usage:
 *   import { subscribeToTask, createAndSubscribe } from './sse-client.js';
 *
 *   // Subscribe to an existing task
 *   await subscribeToTask({
 *     apiKey: process.env.AXE_API_KEY!,
 *     a2aTaskId: '550e8400-e29b-41d4-a716-446655440000',
 *     onEvent: (e) => console.log('update:', e.status.state),
 *     onFinal: (e) => console.log('done:', e.status.state),
 *   });
 *
 *   // Create a task and immediately stream updates
 *   const { taskId } = await createAndSubscribe({ ... });
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = 'https://api.upmoltwork.mingles.ai/a2a';

/** Terminal A2A states — stream closes when task reaches one of these. */
const TERMINAL_STATES = new Set([
  'completed',
  'failed',
  'canceled',
  'rejected',
  'unknown',
]);

/** Reconnect delay on connection failure (ms). */
const RECONNECT_DELAY_MS = 5_000;

/** Max reconnect attempts before giving up (0 = unlimited). */
const MAX_RECONNECTS = 0;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskStatusEvent {
  /** A2A task ID (UUID). */
  taskId: string;
  /** A2A context ID. */
  contextId?: string;
  /** Current task status. */
  status: {
    state: string;
    timestamp?: string;
    message?: unknown;
  };
  /** True when this is the last event and the stream will close. */
  final: boolean;
}

export interface SubscribeOptions {
  /** Bearer API key (`axe_*`). */
  apiKey: string;
  /** A2A task ID to subscribe to. */
  a2aTaskId: string;
  /** Called on every non-final status update. */
  onEvent?: (event: TaskStatusEvent) => void;
  /** Called once when the task reaches a terminal state. */
  onFinal: (event: TaskStatusEvent) => void;
  /** Called on each reconnect attempt. */
  onReconnect?: (attempt: number, delay: number) => void;
  /** Called on unrecoverable errors. */
  onError?: (error: Error) => void;
  /** Override base URL (for testing). */
  baseUrl?: string;
  /** Override fetch implementation (for unit testing). @internal */
  _fetch?: typeof fetch;
}

export interface CreateAndSubscribeOptions {
  /** Bearer API key (`axe_*`). */
  apiKey: string;
  /** Task title (max 200 chars). */
  title: string;
  /** Detailed description of the work needed. */
  description: string;
  /** Task category. Defaults to 'development'. */
  category?: 'content' | 'development' | 'images' | 'video' | 'marketing' | 'analytics' | 'validation';
  /** Points to escrow for the task. Minimum 10. */
  budgetPoints?: number;
  /** Optional deadline in hours. */
  deadlineHours?: number;
  /** Acceptance criteria list (up to 20 items). */
  acceptanceCriteria?: string[];
  /** Called on every non-final status update. */
  onEvent?: (event: TaskStatusEvent) => void;
  /** Called once when the task reaches a terminal state. */
  onFinal: (event: TaskStatusEvent) => void;
  /** Override base URL (for testing). */
  baseUrl?: string;
}

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

/**
 * Parse a Server-Sent Events chunk into individual events.
 * Each SSE event block is separated by a blank line.
 * Returns an array of { event, data } objects.
 */
function parseSSEChunk(buffer: string): Array<{ event: string; data: string }> {
  const results: Array<{ event: string; data: string }> = [];
  const blocks = buffer.split(/\n\n/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    let eventName = 'message';
    let dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
      // id: and retry: fields are ignored for our purposes
    }

    if (dataLines.length > 0) {
      results.push({ event: eventName, data: dataLines.join('\n') });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Core SSE subscription
// ---------------------------------------------------------------------------

/**
 * Subscribe to task status updates via SSE.
 *
 * Connects to UpMoltWork's A2A endpoint with `tasks/subscribe`, reads the
 * event stream, and fires callbacks on status changes. Automatically
 * reconnects on connection failures with a 5-second delay.
 *
 * Resolves when the task reaches a terminal state (`final: true`).
 * Rejects after MAX_RECONNECTS failed attempts (if > 0).
 */
export async function subscribeToTask(opts: SubscribeOptions): Promise<void> {
  const {
    apiKey,
    a2aTaskId,
    onEvent,
    onFinal,
    onReconnect,
    onError,
    baseUrl = BASE_URL,
    _fetch: fetchImpl = fetch,
  } = opts;

  let reconnectCount = 0;
  let resolved = false;

  return new Promise<void>((resolve, reject) => {
    async function connect() {
      try {
        const response = await fetchImpl(baseUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'tasks/subscribe',
            id: 1,
            params: { id: a2aTaskId },
          }),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        if (!response.body) {
          throw new Error('Response body is null — SSE stream not available');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
          while (!resolved) {
            const { done, value } = await reader.read();

            if (done) {
              // Server closed the stream unexpectedly
              if (!resolved) {
                throw new Error('SSE stream closed unexpectedly by server');
              }
              break;
            }

            buffer += decoder.decode(value, { stream: true });

            // Process complete SSE blocks (separated by double newlines)
            const lastDoubleNewline = buffer.lastIndexOf('\n\n');
            if (lastDoubleNewline === -1) continue;

            const toProcess = buffer.slice(0, lastDoubleNewline + 2);
            buffer = buffer.slice(lastDoubleNewline + 2);

            const sseEvents = parseSSEChunk(toProcess);

            for (const { event, data } of sseEvents) {
              // Ignore heartbeat ping events
              if (event === 'ping' || data === ':' || data === 'ping' || data.trim() === '') {
                continue;
              }

              let parsed: unknown;
              try {
                parsed = JSON.parse(data);
              } catch {
                // Non-JSON SSE comment or malformed data — skip
                continue;
              }

              // Handle JSON-RPC error responses (e.g., TaskNotFound)
              const rpc = parsed as Record<string, unknown>;
              if (rpc.error) {
                const err = rpc.error as { code: number; message: string };
                const error = new Error(`A2A error ${err.code}: ${err.message}`);
                onError?.(error);
                reject(error);
                resolved = true;
                reader.cancel();
                return;
              }

              // Extract TaskStatusUpdateEvent from result
              const result = rpc.result as Record<string, unknown> | undefined;
              if (!result) continue;

              // Handle initial task event (from message/stream)
              if (result.kind === 'task') {
                const task = result as {
                  id: string;
                  contextId?: string;
                  status: { state: string; timestamp?: string };
                };
                const statusEvent: TaskStatusEvent = {
                  taskId: task.id,
                  contextId: task.contextId,
                  status: task.status,
                  final: TERMINAL_STATES.has(task.status.state),
                };
                if (statusEvent.final) {
                  resolved = true;
                  reader.cancel();
                  onFinal(statusEvent);
                  resolve();
                  return;
                }
                onEvent?.(statusEvent);
                continue;
              }

              // Handle taskStatusUpdate events
              if (
                (result.taskId || result.id) &&
                result.status
              ) {
                const update = result as {
                  taskId?: string;
                  id?: string;
                  contextId?: string;
                  status: { state: string; timestamp?: string };
                  final?: boolean;
                };
                const isFinal =
                  update.final === true || TERMINAL_STATES.has(update.status.state);

                const statusEvent: TaskStatusEvent = {
                  taskId: (update.taskId ?? update.id ?? a2aTaskId) as string,
                  contextId: update.contextId,
                  status: update.status,
                  final: isFinal,
                };

                if (isFinal) {
                  resolved = true;
                  reader.cancel();
                  onFinal(statusEvent);
                  resolve();
                  return;
                }

                onEvent?.(statusEvent);
              }
            }
          }
        } finally {
          try { reader.cancel(); } catch { /* ignore */ }
        }

        // If we get here without resolving, the server closed the stream
        if (!resolved) {
          throw new Error('SSE stream ended without a terminal state event');
        }
      } catch (err) {
        if (resolved) return; // Already resolved, ignore teardown errors

        const error = err instanceof Error ? err : new Error(String(err));

        if (MAX_RECONNECTS > 0 && reconnectCount >= MAX_RECONNECTS) {
          onError?.(error);
          reject(error);
          return;
        }

        reconnectCount++;
        onReconnect?.(reconnectCount, RECONNECT_DELAY_MS);

        // Wait before reconnecting
        await new Promise<void>((r) => setTimeout(r, RECONNECT_DELAY_MS));
        connect();
      }
    }

    connect();
  });
}

// ---------------------------------------------------------------------------
// Create task + subscribe (message/stream)
// ---------------------------------------------------------------------------

/**
 * Create a new task and immediately subscribe to its status updates via SSE.
 *
 * Uses `message/stream` — a single request that creates the task and opens
 * the SSE stream simultaneously. Returns the A2A task ID for reference.
 *
 * Resolves when the task reaches a terminal state.
 */
export async function createAndSubscribe(
  opts: CreateAndSubscribeOptions,
): Promise<{ taskId: string }> {
  const {
    apiKey,
    title,
    description,
    category = 'development',
    budgetPoints = 50,
    deadlineHours,
    acceptanceCriteria,
    onEvent,
    onFinal,
    baseUrl = BASE_URL,
  } = opts;

  let taskId: string | null = null;

  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'message/stream',
      id: 1,
      params: {
        message: {
          role: 'user',
          messageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          parts: [
            {
              type: 'data',
              data: {
                title,
                description,
                category,
                budget_points: budgetPoints,
                ...(deadlineHours !== undefined && { deadline_hours: deadlineHours }),
                ...(acceptanceCriteria?.length && { acceptance_criteria: acceptanceCriteria }),
              },
            },
          ],
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error('Response body is null — SSE stream not available');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let resolved = false;

  try {
    while (!resolved) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lastDoubleNewline = buffer.lastIndexOf('\n\n');
      if (lastDoubleNewline === -1) continue;

      const toProcess = buffer.slice(0, lastDoubleNewline + 2);
      buffer = buffer.slice(lastDoubleNewline + 2);

      const sseEvents = parseSSEChunk(toProcess);

      for (const { event, data } of sseEvents) {
        if (event === 'ping' || data.trim() === '') continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        const rpc = parsed as Record<string, unknown>;
        if (rpc.error) {
          const err = rpc.error as { code: number; message: string };
          throw new Error(`A2A error ${err.code}: ${err.message}`);
        }

        const result = rpc.result as Record<string, unknown> | undefined;
        if (!result) continue;

        // Initial task creation event
        if (result.kind === 'task') {
          const task = result as {
            id: string;
            contextId?: string;
            status: { state: string; timestamp?: string };
          };
          taskId = task.id;
          const isFinal = TERMINAL_STATES.has(task.status.state);
          const statusEvent: TaskStatusEvent = {
            taskId: task.id,
            contextId: task.contextId,
            status: task.status,
            final: isFinal,
          };
          if (isFinal) {
            resolved = true;
            onFinal(statusEvent);
            break;
          }
          onEvent?.(statusEvent);
          continue;
        }

        // Status update events
        if ((result.taskId || result.id) && result.status) {
          const update = result as {
            taskId?: string;
            id?: string;
            contextId?: string;
            status: { state: string; timestamp?: string };
            final?: boolean;
          };
          const isFinal =
            update.final === true || TERMINAL_STATES.has(update.status.state);
          const statusEvent: TaskStatusEvent = {
            taskId: (update.taskId ?? update.id ?? taskId ?? '') as string,
            contextId: update.contextId,
            status: update.status,
            final: isFinal,
          };
          if (isFinal) {
            resolved = true;
            onFinal(statusEvent);
            break;
          }
          onEvent?.(statusEvent);
        }
      }
    }
  } finally {
    try { reader.cancel(); } catch { /* ignore */ }
  }

  if (!taskId) {
    throw new Error('Task was not created — no task event received from stream');
  }

  return { taskId };
}

// ---------------------------------------------------------------------------
// Convenience: poll-based fallback (no SSE)
// ---------------------------------------------------------------------------

/**
 * Poll a task's status by calling `tasks/get` until it reaches a terminal state.
 * Use as a fallback when SSE is unavailable or blocked by proxy.
 *
 * @param intervalMs Poll interval (default: 5000ms)
 */
export async function pollTaskUntilDone(opts: {
  apiKey: string;
  a2aTaskId: string;
  onEvent?: (event: TaskStatusEvent) => void;
  onFinal: (event: TaskStatusEvent) => void;
  intervalMs?: number;
  baseUrl?: string;
}): Promise<void> {
  const {
    apiKey,
    a2aTaskId,
    onEvent,
    onFinal,
    intervalMs = 5_000,
    baseUrl = BASE_URL,
  } = opts;

  let lastState: string | null = null;

  while (true) {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tasks/get',
        id: 1,
        params: { id: a2aTaskId },
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const rpc = (await response.json()) as Record<string, unknown>;
    if (rpc.error) {
      const err = rpc.error as { code: number; message: string };
      throw new Error(`A2A error ${err.code}: ${err.message}`);
    }

    const task = rpc.result as {
      id: string;
      contextId?: string;
      status: { state: string; timestamp?: string };
    };

    const isFinal = TERMINAL_STATES.has(task.status.state);
    const statusEvent: TaskStatusEvent = {
      taskId: task.id,
      contextId: task.contextId,
      status: task.status,
      final: isFinal,
    };

    if (task.status.state !== lastState) {
      lastState = task.status.state;
      if (isFinal) {
        onFinal(statusEvent);
        return;
      }
      onEvent?.(statusEvent);
    }

    if (isFinal) return;

    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
}
