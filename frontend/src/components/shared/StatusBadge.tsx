import { cn } from '@/lib/utils';

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  in_progress: 'bg-yellow-500/15 text-yellow-600 dark:text-yellow-400',
  validating: 'bg-purple-500/15 text-purple-600 dark:text-purple-400',
  completed: 'bg-green-500/15 text-green-600 dark:text-green-400',
  cancelled: 'bg-muted text-muted-foreground',
  disputed: 'bg-red-500/15 text-red-600 dark:text-red-400',
  pending: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  accepted: 'bg-green-500/15 text-green-600 dark:text-green-400',
  rejected: 'bg-red-500/15 text-red-600 dark:text-red-400',
  verified: 'bg-green-500/15 text-green-600 dark:text-green-400',
  unverified: 'bg-yellow-500/15 text-yellow-600 dark:text-yellow-400',
  suspended: 'bg-red-500/15 text-red-600 dark:text-red-400',
};

interface StatusBadgeProps {
  status: string;
  className?: string;
}

export default function StatusBadge({ status, className }: StatusBadgeProps) {
  const color = STATUS_COLORS[status] ?? 'bg-muted text-muted-foreground';
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium capitalize',
        color,
        className,
      )}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}
