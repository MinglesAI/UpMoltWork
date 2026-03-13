import { randomUUID } from 'node:crypto';
import { eq, and, or, desc } from 'drizzle-orm';
import { db } from '../db/pool.js';
import { tasks, a2aTaskContexts, type AgentRow } from '../db/schema/index.js';
import { generateTaskId } from '../lib/ids.js';
import { escrowDeduct, refundEscrow } from '../lib/transfer.js';
import { TASK_CATEGORIES } from '../routes/tasks.js';
import {
  type A2ATask,
  type A2ATaskState,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type MessageSendParams,
  type GetTaskParams,
  type ListTasksParams,
  type ListTasksResult,
  type CancelTaskParams,
  type SetPushNotificationParams,
  type GetPushNotificationParams,
  A2AErrorCode,
  A2AMethods,
} from './types.js';
import type { A2ATaskContextRow } from '../db/schema/index.js';

// Re-export for SSE
export type { A2ATask, A2ATaskState };

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

export function umwStatusToA2A(umwStatus: string | null): A2ATaskState {
  switch (umwStatus) {
    case 'open':
    case 'bidding':
      return 'submitted';
    case 'in_progress':
    case 'submitted':
      return 'working';
    case 'validating':
      return 'input-required';
    case 'completed':
      return 'completed';
    case 'disputed':
      return 'failed';
    case 'cancelled':
      return 'canceled';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Task mapper
// ---------------------------------------------------------------------------

type UmwTaskRow = typeof tasks.$inferSelect;

export function toA2ATask(umwTask: UmwTaskRow, ctx: A2ATaskContextRow | null): A2ATask {
  const state = umwStatusToA2A(umwTask.status);
  const artifacts = [];

  // If completed, emit an artifact with the task result summary
  if (state === 'completed') {
    artifacts.push({
      artifactId: `artifact-${umwTask.id}`,
      name: 'Task Result',
      description: `Task ${umwTask.id} completed`,
      parts: [
        {
          type: 'data' as const,
          data: {
            task_id: umwTask.id,
            status: umwTask.status,
            title: umwTask.title,
          },
        },
      ],
    });
  }

  return {
    kind: 'task',
    id: ctx?.a2aTaskId ?? umwTask.id,
    contextId: ctx?.contextId ?? undefined,
    status: {
      state,
      timestamp: umwTask.updatedAt?.toISOString() ?? new Date().toISOString(),
    },
    history: [
      {
        role: 'user',
        messageId: `msg-${umwTask.id}-init`,
        parts: [
          {
            type: 'data',
            data: {
              title: umwTask.title,
              description: umwTask.description,
              category: umwTask.category,
              price_points: umwTask.pricePoints ? parseFloat(umwTask.pricePoints) : 0,
            },
          },
        ],
      },
    ],
    artifacts: artifacts.length > 0 ? artifacts : undefined,
    metadata: {
      umw_task_id: umwTask.id,
      creator_agent_id: umwTask.creatorAgentId,
      executor_agent_id: umwTask.executorAgentId ?? undefined,
      created_at: umwTask.createdAt?.toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function rpcError<T = unknown>(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse<T> {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, data },
  } as JsonRpcResponse<T>;
}

function rpcOk<T>(id: string | number | null, result: T): JsonRpcResponse<T> {
  return { jsonrpc: '2.0', id, result };
}

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

async function handleMessageSend(
  id: string | number | null,
  params: MessageSendParams,
  agent: AgentRow,
): Promise<JsonRpcResponse> {
  const { message } = params;

  // Extract DataPart from message
  const dataPart = message.parts.find((p) => p.type === 'data') as
    | { type: 'data'; data: Record<string, unknown> }
    | undefined;

  if (!dataPart) {
    return rpcError(id, A2AErrorCode.InvalidParams, 'Message must contain a DataPart with task details');
  }

  const data = dataPart.data;
  const title = typeof data.title === 'string' ? data.title.trim() : '';
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  const category = typeof data.category === 'string' ? data.category : 'development';
  const budgetPoints =
    typeof data.budget_points === 'number'
      ? data.budget_points
      : typeof data.price_points === 'number'
        ? data.price_points
        : typeof data.budget_points === 'string'
          ? parseFloat(data.budget_points)
          : 0;

  if (!title || title.length > 200) {
    return rpcError(id, A2AErrorCode.InvalidParams, 'title required (max 200 chars)');
  }
  if (!description) {
    return rpcError(id, A2AErrorCode.InvalidParams, 'description required');
  }
  if (!TASK_CATEGORIES.includes(category as (typeof TASK_CATEGORIES)[number])) {
    return rpcError(id, A2AErrorCode.InvalidParams, `Invalid category. Must be one of: ${TASK_CATEGORIES.join(', ')}`);
  }
  if (budgetPoints < 10) {
    return rpcError(id, A2AErrorCode.InvalidParams, 'budget_points must be at least 10');
  }

  if (agent.status !== 'verified') {
    return rpcError(id, A2AErrorCode.InvalidParams, 'Only verified agents can create tasks');
  }

  const taskId = generateTaskId();
  const acceptanceCriteria = Array.isArray(data.acceptance_criteria)
    ? (data.acceptance_criteria as string[]).filter((s): s is string => typeof s === 'string').slice(0, 20)
    : [description.slice(0, 200)];

  const [newTask] = await db
    .insert(tasks)
    .values({
      id: taskId,
      creatorAgentId: agent.id,
      category,
      title,
      description,
      acceptanceCriteria,
      pricePoints: budgetPoints.toString(),
      status: 'open',
    })
    .returning();

  await escrowDeduct({ creatorAgentId: agent.id, amount: budgetPoints, taskId });

  // Insert A2A context row
  const contextId = message.contextId ?? null;
  const pushConfig = params.configuration?.pushNotificationConfig;
  const [ctx] = await db
    .insert(a2aTaskContexts)
    .values({
      umwTaskId: taskId,
      contextId,
      creatorAgentId: agent.id,
      pushWebhookUrl: pushConfig?.url ?? null,
      pushToken: pushConfig?.token ?? null,
    })
    .returning();

  return rpcOk(id, toA2ATask(newTask!, ctx!));
}

async function handleTasksGet(
  id: string | number | null,
  params: GetTaskParams,
  agent: AgentRow,
): Promise<JsonRpcResponse> {
  const { id: a2aTaskId } = params;
  if (!a2aTaskId) {
    return rpcError(id, A2AErrorCode.InvalidParams, 'id is required');
  }

  const [ctx] = await db
    .select()
    .from(a2aTaskContexts)
    .where(eq(a2aTaskContexts.a2aTaskId, a2aTaskId))
    .limit(1);

  if (!ctx) {
    return rpcError(id, A2AErrorCode.TaskNotFound, `Task not found: ${a2aTaskId}`);
  }

  const [task] = await db.select().from(tasks).where(eq(tasks.id, ctx.umwTaskId)).limit(1);
  if (!task) {
    return rpcError(id, A2AErrorCode.TaskNotFound, `UMW task not found: ${ctx.umwTaskId}`);
  }

  return rpcOk(id, toA2ATask(task, ctx));
}

async function handleTasksList(
  id: string | number | null,
  params: ListTasksParams,
  agent: AgentRow,
): Promise<JsonRpcResponse> {
  const pageSize = Math.min(params.pageSize ?? 20, 100);
  // Decode cursor: it's a base64-encoded ISO date string
  let cursorDate: Date | null = null;
  if (params.pageToken) {
    try {
      const decoded = Buffer.from(params.pageToken, 'base64').toString('utf-8');
      cursorDate = new Date(decoded);
    } catch {
      // ignore invalid cursor
    }
  }

  // Fetch tasks: open tasks + tasks created by this agent
  const conditions = [];

  if (cursorDate) {
    conditions.push(
      or(
        eq(tasks.status, 'open'),
        eq(tasks.creatorAgentId, agent.id),
      ),
    );
  }

  const query = db
    .select({
      task: tasks,
      ctx: a2aTaskContexts,
    })
    .from(tasks)
    .leftJoin(a2aTaskContexts, eq(tasks.id, a2aTaskContexts.umwTaskId))
    .where(
      or(
        eq(tasks.status, 'open'),
        eq(tasks.creatorAgentId, agent.id),
      ),
    )
    .orderBy(desc(tasks.createdAt))
    .limit(pageSize + 1);

  const rows = await query;
  const hasMore = rows.length > pageSize;
  const slice = hasMore ? rows.slice(0, pageSize) : rows;

  let nextPageToken: string | undefined;
  if (hasMore && slice.length > 0) {
    const lastTask = slice[slice.length - 1]!.task;
    const cursor = lastTask.createdAt?.toISOString() ?? new Date().toISOString();
    nextPageToken = Buffer.from(cursor).toString('base64');
  }

  const a2aTasks = slice.map((r) => toA2ATask(r.task, r.ctx));

  return rpcOk(id, { tasks: a2aTasks, nextPageToken });
}

async function handleTasksCancel(
  id: string | number | null,
  params: CancelTaskParams,
  agent: AgentRow,
): Promise<JsonRpcResponse> {
  const { id: a2aTaskId } = params;
  if (!a2aTaskId) {
    return rpcError(id, A2AErrorCode.InvalidParams, 'id is required');
  }

  const [ctx] = await db
    .select()
    .from(a2aTaskContexts)
    .where(eq(a2aTaskContexts.a2aTaskId, a2aTaskId))
    .limit(1);

  if (!ctx) {
    return rpcError(id, A2AErrorCode.TaskNotFound, `Task not found: ${a2aTaskId}`);
  }

  // Only the creator can cancel
  if (ctx.creatorAgentId !== agent.id) {
    return rpcError(id, A2AErrorCode.TaskNotCancelable, 'Only the task creator can cancel the task');
  }

  const [task] = await db.select().from(tasks).where(eq(tasks.id, ctx.umwTaskId)).limit(1);
  if (!task) {
    return rpcError(id, A2AErrorCode.TaskNotFound, `UMW task not found: ${ctx.umwTaskId}`);
  }

  const cancelableStatuses = ['open', 'bidding'];
  if (!cancelableStatuses.includes(task.status ?? '')) {
    return rpcError(
      id,
      A2AErrorCode.TaskNotCancelable,
      `Task in status "${task.status}" cannot be cancelled. Only open/bidding tasks can be cancelled.`,
    );
  }

  // Cancel task and refund escrow
  await db
    .update(tasks)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(tasks.id, ctx.umwTaskId));

  const price = parseFloat(task.pricePoints ?? '0');
  if (price > 0) {
    await refundEscrow({ creatorAgentId: agent.id, amount: price, taskId: ctx.umwTaskId });
  }

  const [updatedTask] = await db.select().from(tasks).where(eq(tasks.id, ctx.umwTaskId)).limit(1);
  return rpcOk(id, toA2ATask(updatedTask!, ctx));
}

async function handlePushConfigSet(
  id: string | number | null,
  params: SetPushNotificationParams,
  agent: AgentRow,
): Promise<JsonRpcResponse> {
  const { id: a2aTaskId, pushNotificationConfig } = params;
  if (!a2aTaskId) {
    return rpcError(id, A2AErrorCode.InvalidParams, 'id is required');
  }
  if (!pushNotificationConfig?.url) {
    return rpcError(id, A2AErrorCode.InvalidParams, 'pushNotificationConfig.url is required');
  }

  const [ctx] = await db
    .select()
    .from(a2aTaskContexts)
    .where(eq(a2aTaskContexts.a2aTaskId, a2aTaskId))
    .limit(1);

  if (!ctx) {
    return rpcError(id, A2AErrorCode.TaskNotFound, `Task not found: ${a2aTaskId}`);
  }

  if (ctx.creatorAgentId !== agent.id) {
    return rpcError(id, A2AErrorCode.InvalidParams, 'Only the task creator can configure push notifications');
  }

  await db
    .update(a2aTaskContexts)
    .set({
      pushWebhookUrl: pushNotificationConfig.url,
      pushToken: pushNotificationConfig.token ?? null,
      updatedAt: new Date(),
    })
    .where(eq(a2aTaskContexts.a2aTaskId, a2aTaskId));

  return rpcOk(id, {
    id: a2aTaskId,
    pushNotificationConfig: {
      url: pushNotificationConfig.url,
      token: pushNotificationConfig.token ?? null,
    },
  });
}

async function handlePushConfigGet(
  id: string | number | null,
  params: GetPushNotificationParams,
  agent: AgentRow,
): Promise<JsonRpcResponse> {
  const { id: a2aTaskId } = params;
  if (!a2aTaskId) {
    return rpcError(id, A2AErrorCode.InvalidParams, 'id is required');
  }

  const [ctx] = await db
    .select()
    .from(a2aTaskContexts)
    .where(eq(a2aTaskContexts.a2aTaskId, a2aTaskId))
    .limit(1);

  if (!ctx) {
    return rpcError(id, A2AErrorCode.TaskNotFound, `Task not found: ${a2aTaskId}`);
  }

  if (ctx.creatorAgentId !== agent.id) {
    return rpcError(id, A2AErrorCode.InvalidParams, 'Only the task creator can view push notification config');
  }

  return rpcOk(id, {
    id: a2aTaskId,
    pushNotificationConfig: ctx.pushWebhookUrl
      ? { url: ctx.pushWebhookUrl, token: ctx.pushToken ?? undefined }
      : null,
  });
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

export async function handleA2ARequest(
  req: JsonRpcRequest,
  agent: AgentRow,
): Promise<JsonRpcResponse> {
  if (req.jsonrpc !== '2.0') {
    return rpcError(req.id ?? null, A2AErrorCode.InvalidRequest, 'jsonrpc must be "2.0"');
  }
  if (!req.method) {
    return rpcError(req.id ?? null, A2AErrorCode.InvalidRequest, 'method is required');
  }

  const id = req.id ?? null;

  try {
    switch (req.method) {
      case A2AMethods.MessageSend:
      case A2AMethods.MessageStream:
        return await handleMessageSend(id, req.params as MessageSendParams, agent);

      case A2AMethods.TasksGet:
        return await handleTasksGet(id, req.params as GetTaskParams, agent);

      case A2AMethods.TasksList:
        return await handleTasksList(id, (req.params ?? {}) as ListTasksParams, agent);

      case A2AMethods.TasksCancel:
        return await handleTasksCancel(id, req.params as CancelTaskParams, agent);

      case A2AMethods.TasksPushNotificationSet:
        return await handlePushConfigSet(id, req.params as SetPushNotificationParams, agent);

      case A2AMethods.TasksPushNotificationGet:
        return await handlePushConfigGet(id, req.params as GetPushNotificationParams, agent);

      case A2AMethods.TasksSubscribe:
        // SSE handled at route level; if we get here, return current task state
        return await handleTasksGet(id, req.params as GetTaskParams, agent);

      default:
        return rpcError(id, A2AErrorCode.MethodNotFound, `Method not found: ${req.method}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return rpcError(id, A2AErrorCode.InternalError, message);
  }
}
