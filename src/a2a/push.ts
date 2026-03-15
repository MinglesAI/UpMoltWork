import crypto from 'crypto';
import type { A2ATaskContextRow } from '../db/schema/index.js';
import type { TaskStatusUpdateEvent } from './types.js';
import { emitTaskStatus } from './sse.js';

/**
 * Fire A2A push notification to the registered webhook URL.
 * Signs payload with HMAC-SHA256 using pushToken.
 * Non-blocking — errors are swallowed.
 */
export async function fireA2APush(
  ctx: A2ATaskContextRow,
  event: TaskStatusUpdateEvent,
): Promise<void> {
  if (!ctx.pushWebhookUrl) return;

  const payload = JSON.stringify({
    jsonrpc: '2.0',
    method: 'tasks/pushNotification',
    params: event,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (ctx.pushToken) {
    const signature = crypto
      .createHmac('sha256', ctx.pushToken)
      .update(payload)
      .digest('hex');
    headers['X-A2A-Signature'] = `sha256=${signature}`;
  }

  try {
    await fetch(ctx.pushWebhookUrl, {
      method: 'POST',
      headers,
      body: payload,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Fire-and-forget; ignore failures
  }
}

/**
 * Fire A2A push notification without awaiting (fire-and-forget).
 * Also emits an SSE event so any active task:subscribe streams receive it.
 */
export function fireA2APushAsync(
  ctx: A2ATaskContextRow,
  event: TaskStatusUpdateEvent,
): void {
  // Emit SSE event in-process (no-op if no active listeners)
  emitTaskStatus({
    a2aTaskId: event.taskId,
    state: event.status.state,
    timestamp: event.status.timestamp ?? new Date().toISOString(),
    final: event.final,
    contextId: event.contextId,
  });

  // Fire webhook (fire-and-forget)
  fireA2APush(ctx, event).catch(() => {});
}

/**
 * Notify all channels (SSE + optional webhook) of a task status change.
 * Unlike fireA2APushAsync which requires a webhook URL, this always emits
 * the SSE event and conditionally fires the webhook.
 *
 * Use this instead of the `if (ctx?.pushWebhookUrl) fireA2APushAsync(...)` pattern
 * so that SSE listeners always receive updates regardless of webhook config.
 */
export function notifyA2AStatus(
  ctx: A2ATaskContextRow,
  event: TaskStatusUpdateEvent,
): void {
  // Always emit SSE (in-process, no-op if no active listeners)
  emitTaskStatus({
    a2aTaskId: event.taskId,
    state: event.status.state,
    timestamp: event.status.timestamp ?? new Date().toISOString(),
    final: event.final,
    contextId: event.contextId,
  });

  // Fire webhook only if configured
  if (ctx.pushWebhookUrl) {
    fireA2APush(ctx, event).catch(() => {});
  }
}
