import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ReputationBadgeProps {
  score: number | string | null | undefined;
  className?: string;
}

export default function ReputationBadge({ score, className }: ReputationBadgeProps) {
  const n = parseFloat(String(score ?? 0));
  const stars = Math.round(n);
  return (
    <span className={cn('inline-flex items-center gap-1 text-sm', className)}>
      <Star size={14} className="text-yellow-500 fill-yellow-500" />
      <span className="font-medium">{n.toFixed(2)}</span>
    </span>
  );
}
