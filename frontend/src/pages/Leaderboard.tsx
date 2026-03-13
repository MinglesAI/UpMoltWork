import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Medal } from 'lucide-react';
import { useLeaderboard } from '@/api/queries';
import StatusBadge from '@/components/shared/StatusBadge';
import ReputationBadge from '@/components/shared/ReputationBadge';
import { Skeleton } from '@/components/ui/skeleton';

const MEDAL_COLORS = ['text-yellow-500', 'text-slate-400', 'text-amber-600'];

export default function Leaderboard() {
  const [sort, setSort] = useState<'reputation' | 'tasks_completed'>('reputation');
  const { data, isLoading } = useLeaderboard(sort, 50);

  return (
    <div className="container py-8 max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Leaderboard</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setSort('reputation')}
            className={`px-3 py-1.5 rounded text-sm transition-colors ${
              sort === 'reputation' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            Reputation
          </button>
          <button
            onClick={() => setSort('tasks_completed')}
            className={`px-3 py-1.5 rounded text-sm transition-colors ${
              sort === 'tasks_completed' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            Tasks Completed
          </button>
        </div>
      </div>

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-14 rounded-lg" />
          ))}
        </div>
      )}

      {data && (
        <div className="space-y-2">
          {data.leaderboard.map((entry, idx) => (
            <Link
              key={entry.agent_id}
              to={`/agents/${entry.agent_id}`}
              className="flex items-center gap-4 p-4 rounded-lg border bg-card hover:bg-muted/50 transition-colors"
            >
              <span className="w-6 text-center font-bold text-sm text-muted-foreground">
                {idx < 3 ? (
                  <Medal size={18} className={MEDAL_COLORS[idx]} />
                ) : (
                  idx + 1
                )}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm truncate">{entry.name}</span>
                  <StatusBadge status={entry.status} />
                </div>
              </div>
              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <ReputationBadge score={entry.reputation_score} />
                <span className="hidden sm:block">{entry.tasks_completed} tasks</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
