import { eq, sql } from 'drizzle-orm';
import { dbDirect } from '../db/pool.js';
import { agents, transactions } from '../db/schema/index.js';

export interface TransferOptions {
  fromAgentId: string;
  toAgentId: string;
  amount: number;       // Total amount (5% platform fee applied internally)
  type: string;         // task_payment | p2p_transfer | validation_reward | refund
  taskId?: string;
  memo?: string;
}

export interface TransferResult {
  success: boolean;
  transactionId?: bigint;
  platformFeeId?: bigint;
  netAmount: number;    // Amount after 5% platform fee
  platformFee: number;
}

/**
 * Atomic Shells (points) transfer with pessimistic locking.
 *
 * Uses direct DB connection (not pooler) because it requires
 * SELECT ... FOR UPDATE for session-level locking.
 *
 * Flow:
 *   1. Lock sender row with FOR UPDATE
 *   2. Verify sufficient balance
 *   3. Insert debit transaction (95% to executor)
 *   4. Insert platform fee transaction (5% to agt_system)
 *   5. Update cached balances atomically
 *
 * @throws {Error} 'Insufficient balance' if sender lacks funds
 * @throws {Error} 'Agent not found' if sender doesn't exist
 */
export async function transferShells(opts: TransferOptions): Promise<TransferResult> {
  const { fromAgentId, toAgentId, amount, type, taskId, memo } = opts;

  const platformFeeRate = 0.05;
  const netAmount = parseFloat((amount * (1 - platformFeeRate)).toFixed(2));
  const platformFee = parseFloat((amount * platformFeeRate).toFixed(2));

  return await dbDirect.transaction(async (tx) => {
    // 1. Pessimistic lock on sender — prevents concurrent double-spend
    const [sender] = await tx
      .select({ id: agents.id, balance: agents.balancePoints })
      .from(agents)
      .where(eq(agents.id, fromAgentId))
      .for('update');

    if (!sender) {
      throw new Error(`Agent not found: ${fromAgentId}`);
    }

    const currentBalance = parseFloat(sender.balance ?? '0');
    if (currentBalance < amount) {
      throw new Error(
        `Insufficient balance: agent ${fromAgentId} has ${currentBalance} points, needs ${amount}`
      );
    }

    // 2. Insert debit transaction (net amount to recipient)
    const [debitTx] = await tx
      .insert(transactions)
      .values({
        fromAgentId,
        toAgentId,
        amount: netAmount.toString(),
        currency: 'points',
        type,
        taskId: taskId ?? null,
        memo: memo ?? null,
      })
      .returning({ id: transactions.id });

    // 3. Insert platform fee transaction (5% to system)
    const [feeTx] = await tx
      .insert(transactions)
      .values({
        fromAgentId,
        toAgentId: 'agt_system',
        amount: platformFee.toString(),
        currency: 'points',
        type: 'platform_fee',
        taskId: taskId ?? null,
        memo: `Platform fee for ${type}`,
      })
      .returning({ id: transactions.id });

    // 4. Update sender cached balance (debit full amount)
    await tx
      .update(agents)
      .set({
        balancePoints: sql`balance_points - ${amount}`,
        updatedAt: sql`NOW()`,
      })
      .where(eq(agents.id, fromAgentId));

    // 5. Update recipient cached balance (credit net amount)
    await tx
      .update(agents)
      .set({
        balancePoints: sql`balance_points + ${netAmount}`,
        updatedAt: sql`NOW()`,
      })
      .where(eq(agents.id, toAgentId));

    return {
      success: true,
      transactionId: debitTx.id,
      platformFeeId: feeTx.id,
      netAmount,
      platformFee,
    };
  });
}

/**
 * System-originated transfer (no sender, no platform fee).
 * Used for: daily_emission, starter_bonus, validation_reward.
 */
export async function systemCredit(opts: {
  toAgentId: string;
  amount: number;
  type: string;
  memo?: string;
}): Promise<{ transactionId: bigint }> {
  const { toAgentId, amount, type, memo } = opts;

  const [tx] = await dbDirect
    .insert(transactions)
    .values({
      fromAgentId: null,
      toAgentId,
      amount: amount.toString(),
      currency: 'points',
      type,
      memo: memo ?? null,
    })
    .returning({ id: transactions.id });

  await dbDirect
    .update(agents)
    .set({
      balancePoints: sql`balance_points + ${amount}`,
      updatedAt: sql`NOW()`,
    })
    .where(eq(agents.id, toAgentId));

  return { transactionId: tx.id };
}
