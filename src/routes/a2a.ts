import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { eq } from 'drizzle-orm';
import { db } from '../db/pool.js';
import { tasks, a2aTaskContexts, type AgentRow } from '../db/schema/index.js';
import { authMiddleware } from '../auth.js';
import { handleA2ARequest, toA2ATask, umwStatusToA2A } from '../a2a/handler.js';
import {
  type JsonRpcRequest,
  type A2ATask,
  A2AErrorCode,
  A2AMethods,
} from '../a2a/types.js';
import { sseEmitter, taskStatusEvent, type TaskStatusPayload } from '../a2a/sse.js';

type AppVariables = { agent: AgentRow; agentId: string };

export const a2aRouter = new Hono<{ Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// POST /a2a — JSON-RPC endpoint (A2A Protocol v1.0.0)
// ---------------------------------------------------------------------------

a2aRouter.post('/', authMiddleware, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: A2AErrorCode.ParseError, message: 'Parse error: invalid JSON' },
      },
      400,
    );
  }

  const req = body as JsonRpcRequest;
  const agent = c.get('agent');

  // Check if SSE streaming is requested
  const acceptHeader = c.req.header('Accept') ?? '';
  const isSSE =
    acceptHeader.includes('text/event-stream') ||
    req.method === A2AMethods.MessageStream ||
    req.method === A2AMethods.TasksSubscribe;

  if (isSSE) {
    return handleSSE(c, req, agent);
  }

  // Standard JSON-RPC response
  const response = await handleA2ARequest(req, agent);
  return c.json(response, 200); // A2A always returns 200 for valid JSON-RPC
});

// ---------------------------------------------------------------------------
// SSE constants
// ---------------------------------------------------------------------------

/** Terminal A2A states — stream closes when task reaches one of these. */
const TERMINAL_STATES = new Set(['completed', 'failed', 'canceled', 'rejected', 'unknown']);

/** Heartbeat interval (ms). Keeps proxy/NAT connections alive. */
const HEARTBEAT_MS = 30_000;

/** Maximum SSE connection lifetime (ms). Client must reconnect after this. */
const MAX_LIFETIME_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// SSE handler
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleSSE(c: any, req: JsonRpcRequest, agent: AgentRow) {
  return streamSSE(c, async (stream) => {
    let closed = false;

    stream.onAbort(() => {
      closed = true;
    });

    // -----------------------------------------------------------------------
    // Step 1: Resolve the A2A task
    // -----------------------------------------------------------------------
    let a2aTaskId: string | null = null;
    let contextId: string | null = null;
    let currentState: string | null = null;

    if (req.method === A2AMethods.MessageStream || req.method === A2AMethods.MessageSend) {
      // Create task then stream
      const initResponse = await handleA2ARequest(req, agent);
      if (initResponse.error) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            jsonrpc: '2.0',
            id: req.id ?? null,
            error: initResponse.error,
          }),
        });
        return;
      }
      const task = initResponse.result as A2ATask;
      a2aTaskId = task.id;
      contextId = task.contextId ?? null;
      currentState = task.status.state;

      // Emit initial task object
      await stream.writeSSE({
        id: '1',
        event: 'task-status',
        data: JSON.stringify({
          jsonrpc: '2.0',
          id: req.id ?? null,
          result: {
            kind: 'task',
            id: task.id,
            status: task.status,
            final: TERMINAL_STATES.has(task.status.state),
          },
        }),
      });
    } else if (req.method === A2AMethods.TasksSubscribe) {
      const params = req.params as { id?: string };
      const taskId = params?.id;
      if (!taskId) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            jsonrpc: '2.0',
            id: req.id ?? null,
            error: { code: A2AErrorCode.InvalidParams, message: 'id is required' },
          }),
        });
        return;
      }

      const [ctx] = await db
        .select()
        .from(a2aTaskContexts)
        .where(eq(a2aTaskContexts.a2aTaskId, taskId))
        .limit(1);

      if (!ctx) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            jsonrpc: '2.0',
            id: req.id ?? null,
            error: { code: A2AErrorCode.TaskNotFound, message: `Task not found: ${taskId}` },
          }),
        });
        return;
      }

      const [task] = await db.select().from(tasks).where(eq(tasks.id, ctx.umwTaskId)).limit(1);
      if (!task) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            jsonrpc: '2.0',
            id: req.id ?? null,
            error: { code: A2AErrorCode.TaskNotFound, message: `UMW task not found` },
          }),
        });
        return;
      }

      a2aTaskId = taskId;
      contextId = ctx.contextId ?? null;
      currentState = umwStatusToA2A(task.status);
      const isFinalNow = TERMINAL_STATES.has(currentState);

      // Send initial status
      await stream.writeSSE({
        id: '1',
        event: 'task-status',
        data: JSON.stringify({
          jsonrpc: '2.0',
          id: req.id ?? null,
          result: {
            kind: 'task',
            id: taskId,
            status: {
              state: currentState,
              timestamp: task.updatedAt?.toISOString() ?? new Date().toISOString(),
            },
            final: isFinalNow,
          },
        }),
      });

      // If already terminal → close immediately (one final event + done)
      if (isFinalNow) return;
    } else {
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({
          jsonrpc: '2.0',
          id: req.id ?? null,
          error: { code: A2AErrorCode.MethodNotFound, message: `Method not supported for SSE: ${req.method}` },
        }),
      });
      return;
    }

    if (!a2aTaskId) return;

    // -----------------------------------------------------------------------
    // Step 2: Subscribe via EventEmitter (event-driven, no polling)
    // -----------------------------------------------------------------------
    let eventCounter = 2; // id:1 was the initial event

    // Promise that resolves when the stream should end
    let resolveStream!: () => void;
    const streamDone = new Promise<void>((resolve) => {
      resolveStream = resolve;
    });

    const onStatusUpdate = async (payload: TaskStatusPayload) => {
      if (closed) {
        resolveStream();
        return;
      }

      const isFinal = payload.final || TERMINAL_STATES.has(payload.state);
      currentState = payload.state;

      try {
        await stream.writeSSE({
          id: String(eventCounter++),
          event: 'task-status',
          data: JSON.stringify({
            jsonrpc: '2.0',
            id: req.id ?? null,
            result: {
              kind: 'task',
              id: a2aTaskId,
              status: {
                state: payload.state,
                timestamp: payload.timestamp,
              },
              final: isFinal,
            },
          }),
        });
      } catch {
        closed = true;
      }

      if (isFinal || closed) {
        resolveStream();
      }
    };

    // Register EventEmitter listener
    const eventName = taskStatusEvent(a2aTaskId);
    sseEmitter.on(eventName, onStatusUpdate);

    // -----------------------------------------------------------------------
    // Step 3: Heartbeat + timeout management
    // -----------------------------------------------------------------------
    const heartbeatTimer = setInterval(async () => {
      if (closed) {
        resolveStream();
        return;
      }
      try {
        await stream.writeSSE({
          event: 'ping',
          data: '{}',
        });
      } catch {
        closed = true;
        resolveStream();
      }
    }, HEARTBEAT_MS);

    const lifetimeTimer = setTimeout(() => {
      resolveStream();
    }, MAX_LIFETIME_MS);

    // -----------------------------------------------------------------------
    // Step 4: Wait until stream ends
    // -----------------------------------------------------------------------
    try {
      await streamDone;
    } finally {
      // Clean up — always runs
      clearInterval(heartbeatTimer);
      clearTimeout(lifetimeTimer);
      sseEmitter.off(eventName, onStatusUpdate);
    }
  });
}
