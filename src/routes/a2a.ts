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
  type TaskStatusUpdateEvent,
  A2AErrorCode,
  A2AMethods,
} from '../a2a/types.js';

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
  const statusCode = response.error ? 200 : 200; // A2A always returns 200 for valid JSON-RPC
  return c.json(response, statusCode);
});

// ---------------------------------------------------------------------------
// SSE handler
// ---------------------------------------------------------------------------

// Terminal states — SSE stream closes when task reaches one of these
const TERMINAL_STATES = new Set(['completed', 'failed', 'canceled', 'rejected', 'unknown']);
const POLL_INTERVAL_MS = 2_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleSSE(c: any, req: JsonRpcRequest, agent: AgentRow) {
  // For message/stream: first create/validate the task
  // For tasks/subscribe: look up existing task

  return streamSSE(c, async (stream) => {
    let a2aTaskId: string | null = null;
    let currentState: string | null = null;
    let closed = false;

    stream.onAbort(() => {
      closed = true;
    });

    // --- Initial setup ---
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
      currentState = task.status.state;

      // Emit initial task object
      await stream.writeSSE({
        event: 'task',
        data: JSON.stringify({
          jsonrpc: '2.0',
          id: req.id ?? null,
          result: task,
        }),
      });
    } else if (req.method === A2AMethods.TasksSubscribe) {
      // Subscribe to existing task
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
      currentState = umwStatusToA2A(task.status);

      // If already terminal, emit final update and close
      if (TERMINAL_STATES.has(currentState)) {
        const statusEvent: TaskStatusUpdateEvent = {
          id: a2aTaskId,
          status: { state: currentState as any, timestamp: task.updatedAt?.toISOString() },
          final: true,
        };
        await stream.writeSSE({
          event: 'taskStatusUpdate',
          data: JSON.stringify({
            jsonrpc: '2.0',
            id: req.id ?? null,
            result: statusEvent,
          }),
        });
        return;
      }

      // Emit current state
      const a2aTask = toA2ATask(task, ctx);
      await stream.writeSSE({
        event: 'task',
        data: JSON.stringify({
          jsonrpc: '2.0',
          id: req.id ?? null,
          result: a2aTask,
        }),
      });
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

    // --- Poll for status changes ---
    while (!closed) {
      if (TERMINAL_STATES.has(currentState ?? '')) break;

      await sleep(POLL_INTERVAL_MS);
      if (closed) break;

      try {
        // Lookup via a2a_task_id
        const [ctx] = await db
          .select()
          .from(a2aTaskContexts)
          .where(eq(a2aTaskContexts.a2aTaskId, a2aTaskId))
          .limit(1);

        if (!ctx) break;

        const [task] = await db.select().from(tasks).where(eq(tasks.id, ctx.umwTaskId)).limit(1);
        if (!task) break;

        const newState = umwStatusToA2A(task.status);

        if (newState !== currentState) {
          currentState = newState;
          const isFinal = TERMINAL_STATES.has(newState);
          const statusEvent: TaskStatusUpdateEvent = {
            id: a2aTaskId,
            status: {
              state: newState as any,
              timestamp: task.updatedAt?.toISOString() ?? new Date().toISOString(),
            },
            final: isFinal,
          };

          await stream.writeSSE({
            event: 'taskStatusUpdate',
            data: JSON.stringify({
              jsonrpc: '2.0',
              id: req.id ?? null,
              result: statusEvent,
            }),
          });

          if (isFinal) break;
        }
      } catch {
        break;
      }
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
