import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMyTransactions } from '@/api/dashboard';
import { getDashboardToken } from '@/components/dashboard/DashboardAccess';
import Pagination from '@/components/shared/Pagination';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowUpRight, ArrowDownLeft } from 'lucide-react';

const LIMIT = 20;

const TX_TYPES = ['', 'task_payment', 'validation_reward', 'daily_emission', 'starter_bonus', 'p2p_transfer', 'platform_fee', 'refund', 'escrow_deduct'];

export default function Transactions() {
  const { agentId } = useParams<{ agentId: string }>();
  const token = getDashboardToken(agentId ?? '');
  const [type, setType] = useState('');
  const [offset, setOffset] = useState(0);

  const { data, isLoading } = useMyTransactions(agentId, token ?? undefined, {
    type: type || undefined,
    limit: LIMIT,
    offset,
  });

  const hasMore = (data?.transactions?.length ?? 0) === LIMIT;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-white/85 tracking-tight">Transactions</h1>
        <select
          value={type}
          onChange={(e) => { setType(e.target.value); setOffset(0); }}
          className="px-3 py-1.5 rounded border border-white/10 bg-cyber-bg text-sm text-white/85 focus:outline-none focus:border-accent-blue"
        >
          {TX_TYPES.map(t => (
            <option key={t} value={t}>{t === '' ? 'All Types' : t.replace(/_/g, ' ')}</option>
          ))}
        </select>
      </div>

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14 rounded" />)}
        </div>
      )}

      {data && (
        <>
          {data.transactions.length === 0 ? (
            <p className="text-muted-foreground text-sm py-8 text-center">No transactions found.</p>
          ) : (
            <div className="glass-card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/5">
                    <th className="text-left p-3 text-muted-foreground text-xs uppercase tracking-wider font-medium">Date</th>
                    <th className="text-left p-3 text-muted-foreground text-xs uppercase tracking-wider font-medium">Type</th>
                    <th className="text-left p-3 text-muted-foreground text-xs uppercase tracking-wider font-medium">Amount</th>
                    <th className="text-left p-3 text-muted-foreground text-xs uppercase tracking-wider font-medium hidden sm:table-cell">From / To</th>
                    <th className="text-left p-3 text-muted-foreground text-xs uppercase tracking-wider font-medium hidden md:table-cell">Memo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {data.transactions.map(tx => {
                    const isIncoming = tx.to_agent_id === agentId;
                    return (
                      <tr key={tx.id} className="hover:bg-white/3 transition-colors">
                        <td className="p-3 text-muted-foreground font-mono text-xs">
                          {tx.created_at ? new Date(tx.created_at).toLocaleDateString() : '—'}
                        </td>
                        <td className="p-3">
                          <span className="bg-white/5 border border-white/10 px-2 py-0.5 rounded text-xs capitalize text-muted-foreground">
                            {tx.type.replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td className="p-3">
                          <span className={`flex items-center gap-1 font-mono font-medium text-sm ${isIncoming ? 'text-green-400' : 'text-red-400'}`}>
                            {isIncoming ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}
                            {isIncoming ? '+' : '-'}{tx.amount} {tx.currency}
                          </span>
                        </td>
                        <td className="p-3 text-muted-foreground font-mono text-xs hidden sm:table-cell">
                          {isIncoming
                            ? `from ${tx.from_agent_id ?? 'system'}`
                            : `to ${tx.to_agent_id}`}
                        </td>
                        <td className="p-3 text-muted-foreground hidden md:table-cell max-w-xs truncate text-xs">
                          {tx.memo ?? tx.task_id ?? '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Pagination
            offset={offset}
            limit={LIMIT}
            hasMore={hasMore}
            onPrev={() => setOffset(Math.max(0, offset - LIMIT))}
            onNext={() => setOffset(offset + LIMIT)}
          />
        </>
      )}
    </div>
  );
}
