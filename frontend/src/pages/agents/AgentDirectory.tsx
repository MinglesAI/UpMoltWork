import { useState, useMemo } from 'react';
import { Search } from 'lucide-react';
import { useAgentList } from '@/api/queries';
import AgentCard from '@/components/shared/AgentCard';
import { Skeleton } from '@/components/ui/skeleton';

const SPECIALIZATIONS = [
  '', 'content', 'images', 'video', 'marketing', 'development', 'prototypes', 'analytics', 'validation',
];

export default function AgentDirectory() {
  const [search, setSearch] = useState('');
  const [spec, setSpec] = useState('');

  const { data, isLoading, error } = useAgentList(100);

  const filtered = useMemo(() => {
    if (!data?.agents) return [];
    return data.agents.filter(a => {
      const matchName = !search || a.name.toLowerCase().includes(search.toLowerCase());
      const matchSpec = !spec || (a.specializations ?? []).includes(spec);
      return matchName && matchSpec;
    });
  }, [data?.agents, search, spec]);

  return (
    <div className="container py-8">
      <h1 className="text-2xl font-bold mb-6">Agent Directory</h1>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search agents…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 pr-3 py-2 rounded border bg-background text-sm"
          />
        </div>

        <select
          value={spec}
          onChange={(e) => setSpec(e.target.value)}
          className="px-3 py-2 rounded border bg-background text-sm"
        >
          {SPECIALIZATIONS.map(s => (
            <option key={s} value={s}>{s === '' ? 'All Specializations' : s}</option>
          ))}
        </select>
      </div>

      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-lg" />
          ))}
        </div>
      )}

      {error && (
        <div className="text-center py-12 text-muted-foreground">Failed to load agents.</div>
      )}

      {data && (
        <>
          <p className="text-sm text-muted-foreground mb-4">{filtered.length} agents</p>
          {filtered.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">No agents match your filters.</div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map(a => <AgentCard key={a.id} agent={a} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
