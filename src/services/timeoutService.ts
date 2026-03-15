/**
 * Timeout Service
 *
 * Handles automatic cancellation / escalation of stale gig orders and tasks.
 * Runs every 15 minutes via node-cron (registered in index.ts).
 *
 * Configurable via env vars (all optional — defaults shown in TIMEOUTS):
 *   TIMEOUT_GIG_PENDING_HOURS          default 48
 *   TIMEOUT_GIG_ACCEPTED_BUFFER_DAYS   default 2   (added to gig.delivery_days)
 *   TIMEOUT_GIG_DELIVERED_DAYS         default 7
 *   TIMEOUT_GIG_REVISION_HOURS         default 72
 *   TIMEOUT_TASK_BUFFER_HOURS          default 24  (added to task.deadline)
 *   TIMEOUT_TASK_NO_DEADLINE_DAYS      default 7   (used when no deadline is set)
 *   TIMEOUT_WARNING_HOURS              default 24  (warning sent before timeout)
 */

import { eq, and, lt, sql, isNull, or, isNotNull } from 'drizzle-orm';
import { db } from '../db/pool.js';
import { agents, bids, gigOrders, gigs, tasks } from '../db/schema/index.js';
import {
  refundEscrowForOrder,
  releaseEscrowForOrder,
  refundEscrow,
} from '../lib/transfer.js';
import { fireWebhook } from '../lib/webhooks.js';
import { updateReputation } from '../lib/reputation.js';

// ---------------------------------------------------------------------------
// Timeout configuration
// ---------------------------------------------------------------------------

function envInt(key: string, defaultVal: number): number {
  const v = process.env[key];
  if (!v) return defaultVal;
  const n = parseInt(v, 10);
  return isNaN(n) ? defaultVal : n;
}

export const TIMEOUTS = {
  /** Hours before a pending gig order is auto-cancelled */
  gigPendingHours: () => envInt('TIMEOUT_GIG_PENDING_HOURS', 48),
  /** Extra days added to delivery_days before cancelling an accepted order */
  gigAcceptedBufferDays: () => envInt('TIMEOUT_GIG_ACCEPTED_BUFFER_DAYS', 2),
  /** Days after delivery before a delivered order is auto-completed */
  gigDeliveredDays: () => envInt('TIMEOUT_GIG_DELIVERED_DAYS', 7),
  /** Hours before a revision_requested order is auto-cancelled */
  gigRevisionHours: () => envInt('TIMEOUT_GIG_REVISION_HOURS', 72),
  /** Hours added to task deadline before timing out an in_progress task */
  taskBufferHours: () => envInt('TIMEOUT_TASK_BUFFER_HOURS', 24),
  /** Days before timing out an in_progress task with no deadline */
  taskNoDeadlineDays: () => envInt('TIMEOUT_TASK_NO_DEADLINE_DAYS', 7),
  /** Hours before timeout at which a warning webhook is sent */
  warningHours: () => envInt('TIMEOUT_WARNING_HOURS', 24),
} as const;

// ---------------------------------------------------------------------------
// Gig order timeouts
// ---------------------------------------------------------------------------

/**
 * Process all timed-out gig orders.
 * Scenarios:
 *   pending           → cancelled (buyer refund) after 48h
 *   accepted          → cancelled (buyer refund + seller reputation -0.1) after delivery_days+2 days
 *   delivered         → completed (auto-accept + seller reputation +0.05) after 7 days
 *   revision_requested → cancelled (buyer refund) after 72h
 */
export async function runOrderTimeouts(): Promise<void> {
  try {
    await _cancelPendingOrders();
    await _cancelAcceptedOrders();
    await _autoCompleteDeliveredOrders();
    await _cancelRevisionOrders();
  } catch (err) {
    console.error('[TimeoutService] runOrderTimeouts error:', err);
  }
}

/** Cancel pending orders where seller did not accept within 48h */
async function _cancelPendingOrders(): Promise<void> {
  const cutoff = new Date(Date.now() - TIMEOUTS.gigPendingHours() * 3600_000);

  const rows = await db
    .select({
      id: gigOrders.id,
      buyerAgentId: gigOrders.buyerAgentId,
      sellerAgentId: gigOrders.sellerAgentId,
      pricePoints: gigOrders.pricePoints,
      paymentMode: gigOrders.paymentMode,
    })
    .from(gigOrders)
    .where(
      and(
        eq(gigOrders.status, 'pending'),
        lt(gigOrders.createdAt, cutoff),
      ),
    );

  for (const order of rows) {
    try {
      await db
        .update(gigOrders)
        .set({
          status: 'cancelled',
          cancelledAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(gigOrders.id, order.id), eq(gigOrders.status, 'pending')));

      if (order.paymentMode === 'points') {
        const amount = parseFloat(order.pricePoints ?? '0');
        if (amount > 0) {
          await refundEscrowForOrder({
            buyerAgentId: order.buyerAgentId,
            amount,
            orderId: order.id,
          });
        }
      }

      const data = {
        order_id: order.id,
        reason: 'timeout',
        memo: `Auto-cancelled: seller did not accept within ${TIMEOUTS.gigPendingHours()}h`,
      };
      fireWebhook(order.buyerAgentId, 'gig_order.timeout_cancelled', data);
      fireWebhook(order.sellerAgentId, 'gig_order.timeout_cancelled', data);

      console.log(`[TimeoutService] Cancelled pending order ${order.id} (seller did not accept)`);
    } catch (err) {
      console.error(`[TimeoutService] Failed to cancel pending order ${order.id}:`, err);
    }
  }
}

/** Cancel accepted orders that exceeded delivery_days + buffer */
async function _cancelAcceptedOrders(): Promise<void> {
  const bufferDays = TIMEOUTS.gigAcceptedBufferDays();

  // Join with gigs to get delivery_days per order
  const rows = await db
    .select({
      id: gigOrders.id,
      buyerAgentId: gigOrders.buyerAgentId,
      sellerAgentId: gigOrders.sellerAgentId,
      pricePoints: gigOrders.pricePoints,
      paymentMode: gigOrders.paymentMode,
      acceptedAt: gigOrders.acceptedAt,
      deliveryDays: gigs.deliveryDays,
    })
    .from(gigOrders)
    .innerJoin(gigs, eq(gigs.id, gigOrders.gigId))
    .where(
      and(
        eq(gigOrders.status, 'accepted'),
        isNotNull(gigOrders.acceptedAt),
      ),
    );

  const now = Date.now();

  for (const order of rows) {
    if (!order.acceptedAt) continue;

    const deadlineDays = (order.deliveryDays ?? 7) + bufferDays;
    const deadline = new Date(order.acceptedAt.getTime() + deadlineDays * 86_400_000);

    if (now < deadline.getTime()) continue;

    try {
      await db
        .update(gigOrders)
        .set({
          status: 'cancelled',
          cancelledAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(gigOrders.id, order.id), eq(gigOrders.status, 'accepted')));

      if (order.paymentMode === 'points') {
        const amount = parseFloat(order.pricePoints ?? '0');
        if (amount > 0) {
          await refundEscrowForOrder({
            buyerAgentId: order.buyerAgentId,
            amount,
            orderId: order.id,
          });
        }
      }

      await updateReputation(order.sellerAgentId, -0.1);

      const data = {
        order_id: order.id,
        reason: 'delivery_timeout',
        memo: `Auto-cancelled: seller did not deliver within ${deadlineDays} days`,
      };
      fireWebhook(order.buyerAgentId, 'gig_order.timeout_cancelled', data);
      fireWebhook(order.sellerAgentId, 'gig_order.timeout_cancelled', data);

      console.log(`[TimeoutService] Cancelled accepted order ${order.id} (delivery timeout after ${deadlineDays}d)`);
    } catch (err) {
      console.error(`[TimeoutService] Failed to cancel accepted order ${order.id}:`, err);
    }
  }
}

/** Auto-complete delivered orders where buyer did not respond within 7 days */
async function _autoCompleteDeliveredOrders(): Promise<void> {
  const cutoff = new Date(Date.now() - TIMEOUTS.gigDeliveredDays() * 86_400_000);

  const rows = await db
    .select({
      id: gigOrders.id,
      buyerAgentId: gigOrders.buyerAgentId,
      sellerAgentId: gigOrders.sellerAgentId,
      pricePoints: gigOrders.pricePoints,
      paymentMode: gigOrders.paymentMode,
    })
    .from(gigOrders)
    .where(
      and(
        eq(gigOrders.status, 'delivered'),
        lt(gigOrders.deliveredAt, cutoff),
      ),
    );

  for (const order of rows) {
    try {
      await db
        .update(gigOrders)
        .set({
          status: 'completed',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(gigOrders.id, order.id), eq(gigOrders.status, 'delivered')));

      if (order.paymentMode === 'points') {
        const amount = parseFloat(order.pricePoints ?? '0');
        if (amount > 0) {
          await releaseEscrowForOrder({
            orderId: order.id,
            sellerAgentId: order.sellerAgentId,
            totalAmount: amount,
          });
        }
      }

      await db
        .update(agents)
        .set({
          tasksCompleted: sql`tasks_completed + 1`,
          updatedAt: sql`NOW()`,
        })
        .where(eq(agents.id, order.sellerAgentId));

      await updateReputation(order.sellerAgentId, +0.05);

      const data = {
        order_id: order.id,
        memo: `Auto-completed: buyer did not respond within ${TIMEOUTS.gigDeliveredDays()} days`,
      };
      fireWebhook(order.buyerAgentId, 'gig_order.auto_completed', data);
      fireWebhook(order.sellerAgentId, 'gig_order.auto_completed', data);

      console.log(`[TimeoutService] Auto-completed delivered order ${order.id}`);
    } catch (err) {
      console.error(`[TimeoutService] Failed to auto-complete order ${order.id}:`, err);
    }
  }
}

/** Cancel revision_requested orders where seller did not re-deliver within 72h */
async function _cancelRevisionOrders(): Promise<void> {
  const cutoff = new Date(Date.now() - TIMEOUTS.gigRevisionHours() * 3600_000);

  const rows = await db
    .select({
      id: gigOrders.id,
      buyerAgentId: gigOrders.buyerAgentId,
      sellerAgentId: gigOrders.sellerAgentId,
      pricePoints: gigOrders.pricePoints,
      paymentMode: gigOrders.paymentMode,
    })
    .from(gigOrders)
    .where(
      and(
        eq(gigOrders.status, 'revision_requested'),
        lt(gigOrders.updatedAt, cutoff),
      ),
    );

  for (const order of rows) {
    try {
      await db
        .update(gigOrders)
        .set({
          status: 'cancelled',
          cancelledAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(gigOrders.id, order.id), eq(gigOrders.status, 'revision_requested')));

      if (order.paymentMode === 'points') {
        const amount = parseFloat(order.pricePoints ?? '0');
        if (amount > 0) {
          await refundEscrowForOrder({
            buyerAgentId: order.buyerAgentId,
            amount,
            orderId: order.id,
          });
        }
      }

      const data = {
        order_id: order.id,
        reason: 'revision_timeout',
        memo: `Auto-cancelled: seller did not re-deliver within ${TIMEOUTS.gigRevisionHours()}h`,
      };
      fireWebhook(order.buyerAgentId, 'gig_order.timeout_cancelled', data);
      fireWebhook(order.sellerAgentId, 'gig_order.timeout_cancelled', data);

      console.log(`[TimeoutService] Cancelled revision order ${order.id}`);
    } catch (err) {
      console.error(`[TimeoutService] Failed to cancel revision order ${order.id}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Task timeouts
// ---------------------------------------------------------------------------

/**
 * Process in_progress tasks where executor has gone missing.
 *
 * Deadline logic:
 *   - Task has deadline  → timeout at deadline + TIMEOUT_TASK_BUFFER_HOURS
 *   - No deadline        → timeout at created_at + TIMEOUT_TASK_NO_DEADLINE_DAYS
 *
 * Actions:
 *   - task.status  → 'open', executor_agent_id → null
 *   - All pending/accepted bids from this executor → rejected
 *   - Executor reputation: -0.1
 *   - Webhook: task.executor_timeout to both creator and executor
 */
export async function runTaskTimeouts(): Promise<void> {
  try {
    await _timeoutInProgressTasks();
  } catch (err) {
    console.error('[TimeoutService] runTaskTimeouts error:', err);
  }
}

async function _timeoutInProgressTasks(): Promise<void> {
  const bufferHours = TIMEOUTS.taskBufferHours();
  const noDeadlineDays = TIMEOUTS.taskNoDeadlineDays();
  const now = new Date();

  // Fetch all in_progress tasks with an executor
  const rows = await db
    .select({
      id: tasks.id,
      creatorAgentId: tasks.creatorAgentId,
      executorAgentId: tasks.executorAgentId,
      deadline: tasks.deadline,
      createdAt: tasks.createdAt,
      pricePoints: tasks.pricePoints,
      paymentMode: tasks.paymentMode,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.status, 'in_progress'),
        isNotNull(tasks.executorAgentId),
      ),
    );

  for (const task of rows) {
    // Compute effective deadline
    let effectiveDeadline: Date;
    if (task.deadline) {
      effectiveDeadline = new Date(task.deadline.getTime() + bufferHours * 3600_000);
    } else {
      effectiveDeadline = new Date((task.createdAt ?? now).getTime() + noDeadlineDays * 86_400_000);
    }

    if (now < effectiveDeadline) continue;

    const executorId = task.executorAgentId!;

    try {
      // Re-open the task
      await db
        .update(tasks)
        .set({
          status: 'open',
          executorAgentId: null,
          updatedAt: new Date(),
        })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, 'in_progress')));

      // Reject all bids from this executor on this task
      await db
        .update(bids)
        .set({ status: 'rejected' })
        .where(
          and(
            eq(bids.taskId, task.id),
            eq(bids.agentId, executorId),
            or(eq(bids.status, 'pending'), eq(bids.status, 'accepted')),
          ),
        );

      // Reputation penalty for executor
      await updateReputation(executorId, -0.1);

      const data = {
        task_id: task.id,
        executor_agent_id: executorId,
        reason: 'executor_timeout',
      };
      fireWebhook(task.creatorAgentId, 'task.executor_timeout', data);
      fireWebhook(executorId, 'task.executor_timeout', data);

      console.log(`[TimeoutService] Timed out task ${task.id} (executor ${executorId} gone)`);
    } catch (err) {
      console.error(`[TimeoutService] Failed to time out task ${task.id}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Deadline warnings
// ---------------------------------------------------------------------------

/**
 * Send warning webhooks to relevant parties 24h before a timeout triggers.
 *
 * Events fired:
 *   gig_order.deadline_warning   — for pending / accepted / delivered / revision_requested orders
 *   task.deadline_warning        — for in_progress tasks approaching their timeout
 */
export async function runDeadlineWarnings(): Promise<void> {
  try {
    await _warnGigOrders();
    await _warnTasks();
  } catch (err) {
    console.error('[TimeoutService] runDeadlineWarnings error:', err);
  }
}

async function _warnGigOrders(): Promise<void> {
  const warningMs = TIMEOUTS.warningHours() * 3600_000;
  const now = Date.now();

  // --- pending orders ---
  const pendingHours = TIMEOUTS.gigPendingHours();
  const pendingRows = await db
    .select({
      id: gigOrders.id,
      buyerAgentId: gigOrders.buyerAgentId,
      sellerAgentId: gigOrders.sellerAgentId,
      createdAt: gigOrders.createdAt,
    })
    .from(gigOrders)
    .where(eq(gigOrders.status, 'pending'));

  for (const order of pendingRows) {
    const deadline = new Date((order.createdAt ?? new Date()).getTime() + pendingHours * 3600_000);
    const timeLeft = deadline.getTime() - now;
    if (timeLeft > 0 && timeLeft <= warningMs) {
      const data = { order_id: order.id, deadline: deadline.toISOString(), reason: 'pending_timeout_warning' };
      fireWebhook(order.buyerAgentId, 'gig_order.deadline_warning', data);
      fireWebhook(order.sellerAgentId, 'gig_order.deadline_warning', data);
    }
  }

  // --- accepted orders ---
  const bufferDays = TIMEOUTS.gigAcceptedBufferDays();
  const acceptedRows = await db
    .select({
      id: gigOrders.id,
      buyerAgentId: gigOrders.buyerAgentId,
      sellerAgentId: gigOrders.sellerAgentId,
      acceptedAt: gigOrders.acceptedAt,
      deliveryDays: gigs.deliveryDays,
    })
    .from(gigOrders)
    .innerJoin(gigs, eq(gigs.id, gigOrders.gigId))
    .where(and(eq(gigOrders.status, 'accepted'), isNotNull(gigOrders.acceptedAt)));

  for (const order of acceptedRows) {
    if (!order.acceptedAt) continue;
    const deadlineDays = (order.deliveryDays ?? 7) + bufferDays;
    const deadline = new Date(order.acceptedAt.getTime() + deadlineDays * 86_400_000);
    const timeLeft = deadline.getTime() - now;
    if (timeLeft > 0 && timeLeft <= warningMs) {
      const data = { order_id: order.id, deadline: deadline.toISOString(), reason: 'delivery_deadline_warning' };
      fireWebhook(order.buyerAgentId, 'gig_order.deadline_warning', data);
      fireWebhook(order.sellerAgentId, 'gig_order.deadline_warning', data);
    }
  }

  // --- delivered orders ---
  const deliveredDays = TIMEOUTS.gigDeliveredDays();
  const deliveredRows = await db
    .select({
      id: gigOrders.id,
      buyerAgentId: gigOrders.buyerAgentId,
      sellerAgentId: gigOrders.sellerAgentId,
      deliveredAt: gigOrders.deliveredAt,
    })
    .from(gigOrders)
    .where(and(eq(gigOrders.status, 'delivered'), isNotNull(gigOrders.deliveredAt)));

  for (const order of deliveredRows) {
    if (!order.deliveredAt) continue;
    const deadline = new Date(order.deliveredAt.getTime() + deliveredDays * 86_400_000);
    const timeLeft = deadline.getTime() - now;
    if (timeLeft > 0 && timeLeft <= warningMs) {
      const data = { order_id: order.id, deadline: deadline.toISOString(), reason: 'auto_complete_warning' };
      fireWebhook(order.buyerAgentId, 'gig_order.deadline_warning', data);
      fireWebhook(order.sellerAgentId, 'gig_order.deadline_warning', data);
    }
  }

  // --- revision_requested orders ---
  const revisionHours = TIMEOUTS.gigRevisionHours();
  const revisionRows = await db
    .select({
      id: gigOrders.id,
      buyerAgentId: gigOrders.buyerAgentId,
      sellerAgentId: gigOrders.sellerAgentId,
      updatedAt: gigOrders.updatedAt,
    })
    .from(gigOrders)
    .where(eq(gigOrders.status, 'revision_requested'));

  for (const order of revisionRows) {
    const deadline = new Date((order.updatedAt ?? new Date()).getTime() + revisionHours * 3600_000);
    const timeLeft = deadline.getTime() - now;
    if (timeLeft > 0 && timeLeft <= warningMs) {
      const data = { order_id: order.id, deadline: deadline.toISOString(), reason: 'revision_timeout_warning' };
      fireWebhook(order.buyerAgentId, 'gig_order.deadline_warning', data);
      fireWebhook(order.sellerAgentId, 'gig_order.deadline_warning', data);
    }
  }
}

async function _warnTasks(): Promise<void> {
  const warningMs = TIMEOUTS.warningHours() * 3600_000;
  const bufferHours = TIMEOUTS.taskBufferHours();
  const noDeadlineDays = TIMEOUTS.taskNoDeadlineDays();
  const now = Date.now();

  const rows = await db
    .select({
      id: tasks.id,
      creatorAgentId: tasks.creatorAgentId,
      executorAgentId: tasks.executorAgentId,
      deadline: tasks.deadline,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.status, 'in_progress'),
        isNotNull(tasks.executorAgentId),
      ),
    );

  for (const task of rows) {
    let effectiveDeadline: Date;
    if (task.deadline) {
      effectiveDeadline = new Date(task.deadline.getTime() + bufferHours * 3600_000);
    } else {
      effectiveDeadline = new Date((task.createdAt ?? new Date()).getTime() + noDeadlineDays * 86_400_000);
    }

    const timeLeft = effectiveDeadline.getTime() - now;
    if (timeLeft > 0 && timeLeft <= warningMs) {
      const data = {
        task_id: task.id,
        deadline: effectiveDeadline.toISOString(),
        executor_agent_id: task.executorAgentId,
      };
      fireWebhook(task.creatorAgentId, 'task.deadline_warning', data);
      if (task.executorAgentId) {
        fireWebhook(task.executorAgentId, 'task.deadline_warning', data);
      }
    }
  }
}
