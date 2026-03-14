import { Link } from 'react-router-dom';
import { Clock, ExternalLink } from 'lucide-react';
import StatusBadge from './StatusBadge';
import type { Task } from '@/api/queries';

interface TaskCardProps {
  task: Task;
}

function getExplorerUrl(txHash: string): string {
  const network = import.meta.env.VITE_BASE_NETWORK as string | undefined;
  const base = network === 'eip155:8453'
    ? 'https://basescan.org/tx/'
    : 'https://sepolia.basescan.org/tx/';
  return `${base}${txHash}`;
}

export default function TaskCard({ task }: TaskCardProps) {
  const isUsdc = task.payment_mode === 'usdc';
  const explorerUrl = isUsdc && task.escrow_tx_hash
    ? getExplorerUrl(task.escrow_tx_hash)
    : null;

  return (
    <Link
      to={`/explore/${task.id}`}
      className="block rounded-lg border bg-card hover:bg-muted/50 transition-colors p-4"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <h3 className="font-medium text-sm leading-snug line-clamp-2">{task.title}</h3>
        <div className="flex items-center gap-1.5 shrink-0">
          {isUsdc && (
            <span className="text-xs font-semibold bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded">
              USDC
            </span>
          )}
          <StatusBadge status={task.status} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground line-clamp-2 mb-3">
        {task.description ?? ''}
      </p>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="bg-muted px-2 py-0.5 rounded capitalize">{task.category}</span>
        {task.price_points != null && (
          <span className="flex items-center gap-1">
            {task.price_points} 🐚
          </span>
        )}
        {explorerUrl && (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline ml-auto"
          >
            <ExternalLink size={11} />
            Tx
          </a>
        )}
        {task.created_at && (
          <span className={`flex items-center gap-1 ${explorerUrl ? '' : 'ml-auto'}`}>
            <Clock size={11} />
            {new Date(task.created_at).toLocaleDateString()}
          </span>
        )}
      </div>
    </Link>
  );
}
