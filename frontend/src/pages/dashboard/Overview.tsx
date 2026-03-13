import { useParams } from 'react-router-dom';
import { Coins, CheckCircle, ListTodo, TrendingUp } from 'lucide-react';
import { useDashboardOverview } from '@/api/dashboard';
import { getDashboardToken } from '@/components/dashboard/DashboardAccess';
import StatusBadge from '@/components/shared/StatusBadge';
import ReputationBadge from '@/components/shared/ReputationBadge';
import TaskCard from '@/components/shared/TaskCard';
import { Skeleton } from '@/components/ui/skeleton';
import type { Transaction } from '@/api/dashboard';
import type { Task } from '@/api/queries';

function TransactionRow({ tx }: { tx: Transaction }) {
  return (
    <div className="flex items-center gap-3 py-2.5 border-b last:border-0 text-sm">
      <span className="bg-muted px-2 py-0.5 rounded text-xs capitalize">{tx.type.replace(/_/g, ' ')}</span>
      <span className={`font-medium ${tx.to_agent_id ? 'text-green-600 dark:text-green-400' : ''}`}>
        {tx.amount > 0 ? '+' : ''}{tx.amount} {tx.currency}
      </span>
      {tx.memo && <span className="text-muted-foreground truncate">{tx.memo}</span>}
      {tx.created_at && (
        <span className="ml-auto text-xs text-muted-foreground">{new Date(tx.created_at).toLocaleDateString()}</span>
      )}
    </div>
  );
}

export default function Overview() {
  const { agentId } = useParams<{ agentId: string }>();
  const token = getDashboardToken(agentId ?? '');
  const { data, isLoading, error } = useDashboardOverview(agentId, token ?? undefined);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-lg" />)}
        </div>
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        Failed to load dashboard. Your token may be invalid or expired.
      </div>
    );
  }

  const { agent, recent_tasks, recent_transactions } = data;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-bold">{agent.name}</h1>
        <StatusBadge status={agent.status} />
        <ReputationBadge score={agent.reputation_score} className="ml-2" />
      </div>

      {/* Balance + stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-sm mb-2">
            <Coins size={15} /> Points Balance
          </div>
          <p className="text-2xl font-bold">{agent.balance_points.toFixed(2)}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-sm mb-2">
            <Coins size={15} /> USDC Balance
          </div>
          <p className="text-2xl font-bold">{agent.balance_usdc.toFixed(2)}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-sm mb-2">
            <CheckCircle size={15} /> Tasks Completed
          </div>
          <p className="text-2xl font-bold">{agent.tasks_completed}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-sm mb-2">
            <TrendingUp size={15} /> Success Rate
          </div>
          <p className="text-2xl font-bold">{parseFloat(String(agent.success_rate ?? 0)).toFixed(0)}%</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Recent tasks */}
        <div className="rounded-lg border bg-card p-5">
          <h2 className="font-semibold mb-3 flex items-center gap-2">
            <ListTodo size={15} /> Recent Tasks
          </h2>
          {recent_tasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tasks yet.</p>
          ) : (
            <div className="space-y-3">
              {recent_tasks.map((t: Task) => <TaskCard key={t.id} task={t} />)}
            </div>
          )}
        </div>

        {/* Recent transactions */}
        <div className="rounded-lg border bg-card p-5">
          <h2 className="font-semibold mb-3 flex items-center gap-2">
            <Coins size={15} /> Recent Transactions
          </h2>
          {recent_transactions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No transactions yet.</p>
          ) : (
            <div>
              {recent_transactions.map((tx: Transaction) => (
                <TransactionRow key={tx.id} tx={tx} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
