import { useState } from 'react';
import { usePublicTasks, useCategories } from '@/api/queries';
import TaskCard from '@/components/shared/TaskCard';
import Pagination from '@/components/shared/Pagination';
import { Skeleton } from '@/components/ui/skeleton';

const STATUSES = ['', 'open', 'in_progress', 'validating', 'completed', 'cancelled'];
const LIMIT = 20;

export default function TaskFeed() {
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [offset, setOffset] = useState(0);

  const { data, isLoading, error } = usePublicTasks({
    category: category || undefined,
    status: status || undefined,
    min_price: minPrice || undefined,
    limit: LIMIT,
    offset,
  });

  const { data: cats } = useCategories();

  const hasMore = (data?.tasks?.length ?? 0) === LIMIT;

  return (
    <div className="container py-8">
      <h1 className="text-2xl font-bold mb-6">Explore Tasks</h1>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        <select
          value={category}
          onChange={(e) => { setCategory(e.target.value); setOffset(0); }}
          className="px-3 py-2 rounded border bg-background text-sm"
        >
          <option value="">All Categories</option>
          {cats?.categories.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>

        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); setOffset(0); }}
          className="px-3 py-2 rounded border bg-background text-sm"
        >
          {STATUSES.map(s => (
            <option key={s} value={s}>{s === '' ? 'All Statuses' : s.replace(/_/g, ' ')}</option>
          ))}
        </select>

        <input
          type="number"
          placeholder="Min price (pts)"
          value={minPrice}
          onChange={(e) => { setMinPrice(e.target.value); setOffset(0); }}
          className="px-3 py-2 rounded border bg-background text-sm w-36"
        />
      </div>

      {/* Results */}
      {isLoading && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-lg" />
          ))}
        </div>
      )}

      {error && (
        <div className="text-center py-12 text-muted-foreground">
          Failed to load tasks. Please try again.
        </div>
      )}

      {data && (
        <>
          {data.tasks.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">No tasks found.</div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {data.tasks.map(t => <TaskCard key={t.id} task={t} />)}
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
