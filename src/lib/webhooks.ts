import crypto from 'crypto';
import { eq, and, lte, lt } from 'drizzle-orm';
import { db } from '../db/pool.js';
import { agents, webhookDeliveries } from '../db/schema/index.js';

const RETRY_DELAYS_MS = [5_000, 30_000, 300_000];
const MAX_ATTEMPTS = 3;

function signPayload(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Fire webhook to one agent (non-blocking). Logs to webhook_deliveries.
 * On 3 failures, clears webhook_url so agent must re-enable.
 */
export async function deliverWebhook(agentId: string, event: string, data: Record<string, unknown>): Promise<void> {
  const [agent] = await db.select({ webhookUrl: agents.webhookUrl, webhookSecret: agents.webhookSecret }).from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent?.webhookUrl?.trim() || !agent.webhookSecret) return;

  const payload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  };
  const body = JSON.stringify(payload);
  const signature = signPayload(body, agent.webhookSecret);

  const [row] = await db.insert(webhookDeliveries).values({
    agentId,
    event,
    payload: payload as unknown as Record<string, unknown>,
    attempt: 1,
    delivered: false,
  }).returning({ id: webhookDeliveries.id });

  let statusCode: number | null = null;
  try {
    const res = await fetch(agent.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': `sha256=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    statusCode = res.status;
    if (res.ok) {
      await db.update(webhookDeliveries).set({ delivered: true, statusCode }).where(eq(webhookDeliveries.id, row!.id));
      return;
    }
  } catch {
    statusCode = null;
  }

  const attempt = 1;
  const nextDelay = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  const nextRetryAt = attempt < MAX_ATTEMPTS ? new Date(Date.now() + nextDelay) : null;
  await db.update(webhookDeliveries).set({ statusCode: statusCode ?? undefined, nextRetryAt }).where(eq(webhookDeliveries.id, row!.id));
  // After 3 failures a retry worker would set webhook_url = null; not done in single-attempt path
}

/**
 * Fire webhook without awaiting (fire-and-forget). Use from route handlers.
 */
export function fireWebhook(agentId: string, event: string, data: Record<string, unknown>): void {
  deliverWebhook(agentId, event, data).catch(() => {});
}

/**
 * Process pending webhook deliveries (retries). Call periodically (e.g. every 10s).
 * Pending = delivered=false, attempt < 3, and (nextRetryAt is null or <= now).
 */
export async function runWebhookRetries(): Promise<void> {
  const now = new Date();
  const pending = await db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.delivered, false),
        lt(webhookDeliveries.attempt, MAX_ATTEMPTS),
        lte(webhookDeliveries.nextRetryAt, now)
      )
    )
    .limit(50);
  for (const row of pending) {
    const [agent] = await db.select({ webhookUrl: agents.webhookUrl, webhookSecret: agents.webhookSecret }).from(agents).where(eq(agents.id, row.agentId)).limit(1);
    if (!agent?.webhookUrl?.trim() || !agent.webhookSecret) continue;
    const payload = row.payload as Record<string, unknown>;
    const body = JSON.stringify(payload);
    const signature = signPayload(body, agent.webhookSecret);
    let statusCode: number | null = null;
    try {
      const res = await fetch(agent.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': `sha256=${signature}` },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      statusCode = res.status;
      if (res.ok) {
        await db.update(webhookDeliveries).set({ delivered: true, statusCode }).where(eq(webhookDeliveries.id, row.id));
        continue;
      }
    } catch {
      statusCode = null;
    }
    const nextAttempt = (row.attempt ?? 1) + 1;
    const nextDelay = RETRY_DELAYS_MS[Math.min(nextAttempt - 1, RETRY_DELAYS_MS.length - 1)];
    const nextRetryAt = nextAttempt < MAX_ATTEMPTS ? new Date(Date.now() + nextDelay) : null;
    await db.update(webhookDeliveries).set({ statusCode: statusCode ?? undefined, attempt: nextAttempt, nextRetryAt }).where(eq(webhookDeliveries.id, row.id));
    if (nextAttempt >= MAX_ATTEMPTS) {
      await db.update(agents).set({ webhookUrl: null }).where(eq(agents.id, row.agentId));
    }
  }
}
