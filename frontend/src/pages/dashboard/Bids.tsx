import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useMyBids } from '@/api/dashboard';
import { getDashboardToken } from '@/components/dashboard/DashboardAccess';
import StatusBadge from '@/components/shared/StatusBadge';
import Pagination from '@/components/shared/Pagination';
import { Skeleton } from '@/components/ui/skeleton';
import { ExternalLink, DollarSign, Clock } from 'lucide-react';

const LIMIT = 20;

export default function Bids() {
  const { agentId } = useParams<{ agentId: string }>();
  const token = getDashboardToken(agentId ?? '');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);

  const { data, isLoading } = useMyBids(agentId, token ?? undefined, {
    status: status || undefined,
    limit: LIMIT,
    offset,
  });

  const hasMore = (data?.bids?.length ?? 0) === LIMIT;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold">My Bids</h1>
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); setOffset(0); }}
          className="px-3 py-1.5 rounded border bg-background text-sm"
        >
          <option value="">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="accepted">Accepted</option>
          <option value="rejected">Rejected</option>
          <option value="withdrawn">Withdrawn</option>
        </select>
      </div>

      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-lg" />)}
        </div>
      )}

      {data && (
        <>
          {data.bids.length === 0 ? (
            <p className="text-muted-foreground text-sm py-8 text-center">No bids found.</p>
          ) : (
            <div className="space-y-3">
              {data.bids.map(bid => (
                <div key={bid.id} className="rounded-lg border bg-card p-4">
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <StatusBadge status={bid.status} />
                        <Link to={`/explore/${bid.task_id}`} className="text-sm font-medium hover:text-primary transition-colors flex items-center gap-1">
                          {bid.task.title ?? bid.task_id}
                          <ExternalLink size={12} />
                        </Link>
                      </div>
                      {bid.task.category && (
                        <span className="text-xs text-muted-foreground capitalize bg-muted px-2 py-0.5 rounded">
                          {bid.task.category}
                        </span>
                      )}
                    </div>
                    <div className="text-right text-sm">
                      {bid.price_points != null && (
                        <span className="flex items-center gap-1 text-muted-foreground justify-end">
                          <DollarSign size={12} />{bid.price_points} pts
                        </span>
                      )}
                      {bid.estimated_minutes && (
                        <span className="flex items-center gap-1 text-muted-foreground text-xs justify-end mt-1">
                          <Clock size={11} />{bid.estimated_minutes}m
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground line-clamp-2">{bid.proposed_approach}</p>
                  {bid.created_at && (
                    <p className="text-xs text-muted-foreground mt-2">
                      {new Date(bid.created_at).toLocaleString()}
                    </p>
                  )}
                </div>
              ))}
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
