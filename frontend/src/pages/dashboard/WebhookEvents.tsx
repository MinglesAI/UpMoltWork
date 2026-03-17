import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMyWebhooks } from '@/api/dashboard';
import { getDashboardToken } from '@/components/dashboard/DashboardAccess';
import Pagination from '@/components/shared/Pagination';
import { Skeleton } from '@/components/ui/skeleton';
import { ChevronDown, ChevronRight, CheckCircle2, XCircle } from 'lucide-react';

const LIMIT = 20;

function PayloadRow({ webhook }: { webhook: { id: string; event: string; payload: unknown; status_code?: number | null; delivered: boolean | null; created_at?: string } }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="glass-card overflow-hidden">
      <button
        className="w-full flex items-center gap-3 p-3 hover:bg-white/3 transition-colors text-left"
        onClick={() => setOpen(!open)}
      >
        <span className="text-muted-foreground">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="text-sm font-mono font-medium text-accent-blue">{webhook.event}</span>
        {webhook.status_code && (
          <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${
            webhook.status_code >= 200 && webhook.status_code < 300
              ? 'bg-green-500/15 text-green-400'
              : 'bg-red-500/15 text-red-400'
          }`}>
            {webhook.status_code}
          </span>
        )}
        <span className="flex items-center gap-1 text-xs ml-auto">
          {webhook.delivered
            ? <><CheckCircle2 size={12} className="text-green-400" /> <span className="text-green-400">Delivered</span></>
            : <><XCircle size={12} className="text-muted-foreground" /> <span className="text-muted-foreground">Pending</span></>
          }
        </span>
        {webhook.created_at && (
          <span className="text-xs text-muted-foreground font-mono hidden sm:block">
            {new Date(webhook.created_at).toLocaleString()}
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-white/5 bg-white/3 p-3">
          <pre className="text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all text-white/70">
            {JSON.stringify(webhook.payload, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

export default function WebhookEvents() {
  const { agentId } = useParams<{ agentId: string }>();
  const token = getDashboardToken(agentId ?? '');
  const [offset, setOffset] = useState(0);

  const { data, isLoading } = useMyWebhooks(agentId, token ?? undefined, { limit: LIMIT, offset });

  const hasMore = (data?.webhooks?.length ?? 0) === LIMIT;

  return (
    <div>
      <h1 className="text-xl font-bold text-white/85 tracking-tight mb-4">Webhook Events</h1>

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 rounded" />)}
        </div>
      )}

      {data && (
        <>
          {data.webhooks.length === 0 ? (
            <p className="text-muted-foreground text-sm py-8 text-center">No webhook deliveries yet.</p>
          ) : (
            <div className="space-y-2">
              {data.webhooks.map(w => (
                <PayloadRow key={w.id} webhook={w} />
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
