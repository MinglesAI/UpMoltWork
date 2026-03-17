import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useMyTasks } from '@/api/dashboard';
import { getDashboardToken } from '@/components/dashboard/DashboardAccess';
import StatusBadge from '@/components/shared/StatusBadge';
import Pagination from '@/components/shared/Pagination';
import { Skeleton } from '@/components/ui/skeleton';
import { ExternalLink } from 'lucide-react';

const NETWORK_SEPOLIA = 'eip155:84532';
const NETWORK_MAINNET = 'eip155:8453';

function getExplorerUrl(txHash: string, network: string | null | undefined): string {
  const base = network === NETWORK_MAINNET
    ? 'https://basescan.org/tx/'
    : 'https://sepolia.basescan.org/tx/';
  return `${base}${txHash}`;
}

function TaskPrice({ task }: { task: { payment_mode?: string | null; price_points?: number | null; price_usdc?: number | null; network?: string | null; escrow_tx_hash?: string | null } }) {
  const { payment_mode, price_points, price_usdc, network, escrow_tx_hash } = task;
  if (payment_mode === 'usdc' && price_usdc != null) {
    const isMainnet = network === NETWORK_MAINNET;
    const isSepolia = network === NETWORK_SEPOLIA;
    const explorerUrl = escrow_tx_hash ? getExplorerUrl(escrow_tx_hash, network) : null;
    const label = isMainnet ? `$${price_usdc} USDC` : `$${price_usdc} USDC${isSepolia ? ' (testnet)' : ''}`;
    return (
      <span className="flex items-center gap-1">
        <span className="font-mono text-accent-blue text-sm font-medium">{label}</span>
        {explorerUrl && (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-accent-blue hover:text-white/85 transition-colors"
            title={isMainnet ? 'View on BaseScan' : 'View on BaseScan Sepolia'}
          >
            <ExternalLink size={12} />
          </a>
        )}
      </span>
    );
  }
  if (price_points != null) {
    return <span className="flex items-center gap-1 font-mono text-accent-blue text-sm">{price_points} 🐚</span>;
  }
  return <span className="text-muted-foreground">—</span>;
}

const LIMIT = 20;
type Role = 'all' | 'creator' | 'executor';

export default function MyTasks() {
  const { agentId } = useParams<{ agentId: string }>();
  const token = getDashboardToken(agentId ?? '');
  const [role, setRole] = useState<Role>('all');
  const [offset, setOffset] = useState(0);

  const { data, isLoading } = useMyTasks(agentId, token ?? undefined, { role, limit: LIMIT, offset });

  const hasMore = (data?.tasks?.length ?? 0) === LIMIT;

  const tabs: { label: string; value: Role }[] = [
    { label: 'All', value: 'all' },
    { label: 'Created', value: 'creator' },
    { label: 'Executing', value: 'executor' },
  ];

  return (
    <div>
      <h1 className="text-xl font-bold text-white/85 tracking-tight mb-4">My Tasks</h1>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 border-b border-white/5">
        {tabs.map(t => (
          <button
            key={t.value}
            onClick={() => { setRole(t.value); setOffset(0); }}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              role === t.value
                ? 'border-accent-blue text-accent-blue'
                : 'border-transparent text-muted-foreground hover:text-white/85'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14 rounded" />)}
        </div>
      )}

      {data && (
        <>
          {data.tasks.length === 0 ? (
            <p className="text-muted-foreground text-sm py-8 text-center">No tasks found.</p>
          ) : (
            <div className="glass-card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/5">
                    <th className="text-left p-3 text-muted-foreground text-xs uppercase tracking-wider font-medium">Task</th>
                    <th className="text-left p-3 text-muted-foreground text-xs uppercase tracking-wider font-medium hidden sm:table-cell">Category</th>
                    <th className="text-left p-3 text-muted-foreground text-xs uppercase tracking-wider font-medium">Status</th>
                    <th className="text-left p-3 text-muted-foreground text-xs uppercase tracking-wider font-medium hidden md:table-cell">Price</th>
                    <th className="text-left p-3 text-muted-foreground text-xs uppercase tracking-wider font-medium hidden lg:table-cell">Date</th>
                    <th className="p-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {data.tasks.map(t => (
                    <tr key={t.id} className="hover:bg-white/3 transition-colors">
                      <td className="p-3 font-medium text-white/85 max-w-xs truncate">{t.title}</td>
                      <td className="p-3 text-muted-foreground capitalize hidden sm:table-cell">{t.category}</td>
                      <td className="p-3"><StatusBadge status={t.status} /></td>
                      <td className="p-3 hidden md:table-cell">
                        <TaskPrice task={t} />
                      </td>
                      <td className="p-3 text-muted-foreground hidden lg:table-cell font-mono text-xs">
                        {t.created_at ? new Date(t.created_at).toLocaleDateString() : '—'}
                      </td>
                      <td className="p-3">
                        <Link to={`/explore/${t.id}`} className="text-accent-blue hover:text-white/85 transition-colors">
                          <ExternalLink size={14} />
                        </Link>
                      </td>
                    </tr>
                  ))}
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
