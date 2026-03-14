import { Link } from 'react-router-dom';
import { Clock, ExternalLink } from 'lucide-react';
import StatusBadge from './StatusBadge';
import type { Task } from '@/api/queries';

interface TaskCardProps {
  task: Task;
}

const NETWORK_SEPOLIA = 'eip155:84532';
const NETWORK_MAINNET = 'eip155:8453';

function getExplorerUrl(txHash: string, network: string | null | undefined): string {
  const base = network === NETWORK_MAINNET
    ? 'https://basescan.org/tx/'
    : 'https://sepolia.basescan.org/tx/';
  return `${base}${txHash}`;
}

function PriceBadge({ task }: { task: Task }) {
  const { payment_mode, price_points, price_usdc, network, escrow_tx_hash } = task;

  if (payment_mode === 'usdc' && price_usdc != null) {
    const isMainnet = network === NETWORK_MAINNET;
    const isSepolia = network === NETWORK_SEPOLIA;
    const explorerUrl = escrow_tx_hash ? getExplorerUrl(escrow_tx_hash, network) : null;
    const label = isMainnet
      ? `$${price_usdc} USDC`
      : `$${price_usdc} USDC${isSepolia ? ' (testnet)' : ''}`;

    return (
      <span className="flex items-center gap-1">
        <span className="text-xs font-semibold bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded">
          {label}
        </span>
        {explorerUrl && (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200"
            title={isMainnet ? 'View on BaseScan' : 'View on BaseScan Sepolia'}
          >
            <ExternalLink size={11} />
          </a>
        )}
      </span>
    );
  }

  if (price_points != null) {
    return (
      <span className="flex items-center gap-1">
        {price_points} 🐚
      </span>
    );
  }

  return null;
}

export default function TaskCard({ task }: TaskCardProps) {
  return (
    <Link
      to={`/explore/${task.id}`}
      className="block rounded-lg border bg-card hover:bg-muted/50 transition-colors p-4"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <h3 className="font-medium text-sm leading-snug line-clamp-2">{task.title}</h3>
        <div className="flex items-center gap-1.5 shrink-0">
          <StatusBadge status={task.status} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground line-clamp-2 mb-3">
        {task.description ?? ''}
      </p>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="bg-muted px-2 py-0.5 rounded capitalize">{task.category}</span>
        <PriceBadge task={task} />
        {task.created_at && (
          <span className="flex items-center gap-1 ml-auto">
            <Clock size={11} />
            {new Date(task.created_at).toLocaleDateString()}
          </span>
        )}
      </div>
    </Link>
  );
}
