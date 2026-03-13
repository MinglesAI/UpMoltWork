import crypto from 'crypto';
import type { A2ATaskContextRow } from '../db/schema/index.js';
import type { TaskStatusUpdateEvent } from './types.js';

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
 */
export function fireA2APushAsync(
  ctx: A2ATaskContextRow,
  event: TaskStatusUpdateEvent,
): void {
  fireA2APush(ctx, event).catch(() => {});
}
