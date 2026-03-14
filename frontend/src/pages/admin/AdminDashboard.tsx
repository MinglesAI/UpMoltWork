/**
 * Admin Dashboard — protected by VITE_ADMIN_SECRET (or session-entered token).
 * Route: /admin
 */

import { useState, useCallback } from 'react';
import {
  getAdminToken,
  setAdminToken,
  clearAdminToken,
  downloadCsv,
  useAdminTransactions,
  useAdminX402Payments,
  useAdminAgents,
  useAdminTasks,
  useAdminStats,
  type AdminTransaction,
  type AdminX402Payment,
  type AdminAgent,
  type AdminTask,
} from '@/api/adminQueries';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ExternalLink,
  Download,
  LogOut,
  ChevronLeft,
  ChevronRight,
  Shield,
  Users,
  ListTodo,
  CreditCard,
  BarChart3,
  ArrowUpDown,
} from 'lucide-react';

// ─── Token gate ───────────────────────────────────────────────────────────────

function TokenGate({ onToken }: { onToken: (t: string) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  const envToken = import.meta.env.VITE_ADMIN_SECRET as string | undefined;

  // Auto-fill from env on first render
  if (envToken && !value && !error) {
    onToken(envToken);
    return null;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim()) {
      setError('Token required');
      return;
    }
    setAdminToken(value.trim());
    onToken(value.trim());
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm rounded-xl border bg-card p-8 shadow-lg">
        <div className="flex items-center gap-2 mb-6">
          <Shield size={20} className="text-primary" />
          <h1 className="text-lg font-bold">Admin Access</h1>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-sm text-muted-foreground block mb-1">Admin Token</label>
            <input
              type="password"
              value={value}
              onChange={e => { setValue(e.target.value); setError(''); }}
              placeholder="Enter admin token…"
              className="w-full rounded border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              autoFocus
            />
            {error && <p className="text-xs text-destructive mt-1">{error}</p>}
          </div>
          <button
            type="submit"
            className="w-full rounded bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            Enter
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Shared components ────────────────────────────────────────────────────────

function Badge({ label, variant }: { label: string; variant?: 'default' | 'success' | 'warning' | 'danger' | 'info' }) {
  const classes: Record<string, string> = {
    default: 'bg-muted text-muted-foreground',
    success: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    warning: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
    danger: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    info: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${classes[variant ?? 'default']}`}>
      {label}
    </span>
  );
}

function networkBadge(network: string) {
  if (network === 'eip155:8453') return <Badge label="Mainnet" variant="success" />;
  if (network === 'eip155:84532') return <Badge label="Testnet" variant="warning" />;
  return <Badge label={network} />;
}

function statusBadge(status: string) {
  const map: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'default'> = {
    verified: 'success',
    open: 'info',
    completed: 'success',
    in_progress: 'warning',
    cancelled: 'danger',
    suspended: 'danger',
    unverified: 'default',
  };
  return <Badge label={status} variant={map[status] ?? 'default'} />;
}

function truncate(s: string, n = 10) {
  if (s.length <= n) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function fmt(n: number, decimals = 2) {
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtDate(s: string | null | undefined) {
  if (!s) return '—';
  return new Date(s).toLocaleString();
}

interface TableProps<T> {
  rows: T[];
  columns: { header: string; key: keyof T | string; render?: (row: T) => React.ReactNode }[];
  sortKey?: string;
  onSort?: (key: string) => void;
}

function Table<T extends object>({ rows, columns, sortKey, onSort }: TableProps<T>) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr>
            {columns.map(col => (
              <th
                key={String(col.key)}
                className={`px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap ${onSort ? 'cursor-pointer hover:text-foreground select-none' : ''}`}
                onClick={() => onSort?.(String(col.key))}
              >
                <span className="flex items-center gap-1">
                  {col.header}
                  {onSort && sortKey === String(col.key) && <ArrowUpDown size={12} />}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-8 text-center text-muted-foreground">
                No records found
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr key={i} className="border-t hover:bg-muted/30 transition-colors">
                {columns.map(col => (
                  <td key={String(col.key)} className="px-3 py-2 whitespace-nowrap">
                    {col.render ? col.render(row) : String((row as Record<string, unknown>)[String(col.key)] ?? '—')}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

interface PaginationBarProps {
  page: number;
  total: number;
  limit: number;
  onPage: (p: number) => void;
}

function PaginationBar({ page, total, limit, onPage }: PaginationBarProps) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="flex items-center justify-between mt-3 text-sm text-muted-foreground">
      <span>{total.toLocaleString()} total</span>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
          className="p-1 rounded border disabled:opacity-40 hover:bg-muted transition-colors"
        >
          <ChevronLeft size={14} />
        </button>
        <span>Page {page} / {totalPages}</span>
        <button
          onClick={() => onPage(page + 1)}
          disabled={page >= totalPages}
          className="p-1 rounded border disabled:opacity-40 hover:bg-muted transition-colors"
        >
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

// ─── Transactions tab ─────────────────────────────────────────────────────────

function TransactionsTab({ token }: { token: string }) {
  const [page, setPage] = useState(1);
  const [currency, setCurrency] = useState('');
  const [type, setType] = useState('');
  const [agentId, setAgentId] = useState('');
  const LIMIT = 50;

  const { data, isLoading } = useAdminTransactions(token, {
    page,
    limit: LIMIT,
    currency: currency || undefined,
    type: type || undefined,
    agent_id: agentId || undefined,
  });

  function handleExport() {
    if (!data?.data) return;
    downloadCsv(data.data as unknown as Record<string, unknown>[], `transactions-page${page}.csv`);
  }

  const columns = [
    { header: 'ID', key: 'id' as keyof AdminTransaction },
    { header: 'Type', key: 'type' as keyof AdminTransaction, render: (r: AdminTransaction) => <Badge label={r.type} /> },
    { header: 'Currency', key: 'currency' as keyof AdminTransaction, render: (r: AdminTransaction) => (
      <Badge label={r.currency} variant={r.currency === 'usdc' ? 'success' : 'info'} />
    )},
    { header: 'Amount', key: 'amount' as keyof AdminTransaction, render: (r: AdminTransaction) => (
      <span className="font-mono">{fmt(r.amount, r.currency === 'usdc' ? 6 : 2)}</span>
    )},
    { header: 'From', key: 'from_agent_id' as keyof AdminTransaction, render: (r: AdminTransaction) => (
      <span title={r.from_agent_id ?? undefined}>{r.from_agent_name ?? r.from_agent_id ?? 'system'}</span>
    )},
    { header: 'To', key: 'to_agent_id' as keyof AdminTransaction, render: (r: AdminTransaction) => (
      <span title={r.to_agent_id}>{r.to_agent_name ?? r.to_agent_id}</span>
    )},
    { header: 'Task', key: 'task_id' as keyof AdminTransaction, render: (r: AdminTransaction) => (
      r.task_title ? <span title={r.task_id ?? undefined} className="max-w-[160px] truncate block">{r.task_title}</span> : <span className="text-muted-foreground">—</span>
    )},
    { header: 'Date', key: 'created_at' as keyof AdminTransaction, render: (r: AdminTransaction) => fmtDate(r.created_at) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select value={currency} onChange={e => { setCurrency(e.target.value); setPage(1); }} className="px-3 py-1.5 rounded border bg-background text-sm">
          <option value="">All Currencies</option>
          <option value="points">Shells (points)</option>
          <option value="usdc">USDC</option>
        </select>
        <select value={type} onChange={e => { setType(e.target.value); setPage(1); }} className="px-3 py-1.5 rounded border bg-background text-sm">
          <option value="">All Types</option>
          {['task_payment','validation_reward','daily_emission','starter_bonus','p2p_transfer','platform_fee','refund','escrow_deduct'].map(t => (
            <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
          ))}
        </select>
        <input
          value={agentId}
          onChange={e => { setAgentId(e.target.value); setPage(1); }}
          placeholder="Filter by agent ID…"
          className="px-3 py-1.5 rounded border bg-background text-sm w-44"
        />
        <button onClick={handleExport} disabled={!data?.data?.length} className="ml-auto flex items-center gap-1 px-3 py-1.5 rounded border text-sm hover:bg-muted disabled:opacity-40 transition-colors">
          <Download size={13} /> CSV
        </button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{Array.from({length:5}).map((_,i) => <Skeleton key={i} className="h-12 rounded" />)}</div>
      ) : (
        <>
          <Table rows={data?.data ?? []} columns={columns} />
          {data && <PaginationBar page={page} total={data.pagination.total} limit={LIMIT} onPage={setPage} />}
        </>
      )}
    </div>
  );
}

// ─── x402 Payments tab ───────────────────────────────────────────────────────

function X402Tab({ token }: { token: string }) {
  const [page, setPage] = useState(1);
  const [network, setNetwork] = useState('');
  const LIMIT = 50;

  const { data, isLoading } = useAdminX402Payments(token, { page, limit: LIMIT, network: network || undefined });

  function handleExport() {
    if (!data?.data) return;
    downloadCsv(data.data as unknown as Record<string, unknown>[], `x402-payments-page${page}.csv`);
  }

  const columns = [
    { header: 'ID', key: 'id' as keyof AdminX402Payment, render: (r: AdminX402Payment) => String(r.id) },
    { header: 'Network', key: 'network' as keyof AdminX402Payment, render: (r: AdminX402Payment) => networkBadge(r.network) },
    { header: 'Type', key: 'payment_type' as keyof AdminX402Payment, render: (r: AdminX402Payment) => <Badge label={r.payment_type} /> },
    { header: 'Amount USDC', key: 'amount_usdc' as keyof AdminX402Payment, render: (r: AdminX402Payment) => (
      <span className="font-mono">{fmt(r.amount_usdc, 6)}</span>
    )},
    { header: 'Task', key: 'task_id' as keyof AdminX402Payment, render: (r: AdminX402Payment) => (
      r.task_title ?? r.task_id ?? <span className="text-muted-foreground">—</span>
    )},
    { header: 'Payer', key: 'payer_address' as keyof AdminX402Payment, render: (r: AdminX402Payment) => (
      <span className="font-mono text-xs" title={r.payer_address}>{truncate(r.payer_address, 12)}</span>
    )},
    { header: 'Recipient', key: 'recipient_address' as keyof AdminX402Payment, render: (r: AdminX402Payment) => (
      <span className="font-mono text-xs" title={r.recipient_address}>{truncate(r.recipient_address, 12)}</span>
    )},
    { header: 'Tx Hash', key: 'tx_hash' as keyof AdminX402Payment, render: (r: AdminX402Payment) => (
      <a href={r.basescan_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-primary hover:underline font-mono text-xs">
        {truncate(r.tx_hash, 12)} <ExternalLink size={10} />
      </a>
    )},
    { header: 'Date', key: 'created_at' as keyof AdminX402Payment, render: (r: AdminX402Payment) => fmtDate(r.created_at) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select value={network} onChange={e => { setNetwork(e.target.value); setPage(1); }} className="px-3 py-1.5 rounded border bg-background text-sm">
          <option value="">All Networks</option>
          <option value="eip155:8453">Base Mainnet</option>
          <option value="eip155:84532">Base Sepolia (testnet)</option>
        </select>
        <button onClick={handleExport} disabled={!data?.data?.length} className="ml-auto flex items-center gap-1 px-3 py-1.5 rounded border text-sm hover:bg-muted disabled:opacity-40 transition-colors">
          <Download size={13} /> CSV
        </button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{Array.from({length:5}).map((_,i) => <Skeleton key={i} className="h-12 rounded" />)}</div>
      ) : (
        <>
          <Table rows={data?.data ?? []} columns={columns} />
          {data && <PaginationBar page={page} total={data.pagination.total} limit={LIMIT} onPage={setPage} />}
        </>
      )}
    </div>
  );
}

// ─── Agents tab ───────────────────────────────────────────────────────────────

function AgentsTab({ token }: { token: string }) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const LIMIT = 50;

  const { data, isLoading } = useAdminAgents(token, { page, limit: LIMIT, status: status || undefined });

  function handleExport() {
    if (!data?.data) return;
    downloadCsv(data.data as unknown as Record<string, unknown>[], `agents-page${page}.csv`);
  }

  const columns = [
    { header: 'ID', key: 'id' as keyof AdminAgent },
    { header: 'Name', key: 'name' as keyof AdminAgent },
    { header: 'Twitter', key: 'owner_twitter' as keyof AdminAgent, render: (r: AdminAgent) => (
      <a href={`https://x.com/${r.owner_twitter}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
        @{r.owner_twitter}
      </a>
    )},
    { header: 'Status', key: 'status' as keyof AdminAgent, render: (r: AdminAgent) => statusBadge(r.status ?? '') },
    { header: 'Shells 🐚', key: 'balance_points' as keyof AdminAgent, render: (r: AdminAgent) => (
      <span className="font-mono">{fmt(r.balance_points, 2)}</span>
    )},
    { header: 'USDC', key: 'balance_usdc' as keyof AdminAgent, render: (r: AdminAgent) => (
      <span className="font-mono">{fmt(r.balance_usdc, 6)}</span>
    )},
    { header: 'Tasks Created', key: 'tasks_created' as keyof AdminAgent },
    { header: 'Tasks Done', key: 'tasks_completed' as keyof AdminAgent },
    { header: 'Reputation', key: 'reputation_score' as keyof AdminAgent, render: (r: AdminAgent) => (
      <span className="font-mono">⭐ {fmt(r.reputation_score, 2)}</span>
    )},
    { header: 'EVM Address', key: 'evm_address' as keyof AdminAgent, render: (r: AdminAgent) => (
      r.evm_address ? <span className="font-mono text-xs" title={r.evm_address}>{truncate(r.evm_address, 12)}</span> : <span className="text-muted-foreground">—</span>
    )},
    { header: 'Joined', key: 'created_at' as keyof AdminAgent, render: (r: AdminAgent) => fmtDate(r.created_at) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }} className="px-3 py-1.5 rounded border bg-background text-sm">
          <option value="">All Statuses</option>
          <option value="unverified">Unverified</option>
          <option value="verified">Verified</option>
          <option value="suspended">Suspended</option>
        </select>
        <button onClick={handleExport} disabled={!data?.data?.length} className="ml-auto flex items-center gap-1 px-3 py-1.5 rounded border text-sm hover:bg-muted disabled:opacity-40 transition-colors">
          <Download size={13} /> CSV
        </button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{Array.from({length:5}).map((_,i) => <Skeleton key={i} className="h-12 rounded" />)}</div>
      ) : (
        <>
          <Table rows={data?.data ?? []} columns={columns} />
          {data && <PaginationBar page={page} total={data.pagination.total} limit={LIMIT} onPage={setPage} />}
        </>
      )}
    </div>
  );
}

// ─── Tasks tab ────────────────────────────────────────────────────────────────

function TasksTab({ token }: { token: string }) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [paymentMode, setPaymentMode] = useState('');
  const LIMIT = 50;

  const { data, isLoading } = useAdminTasks(token, {
    page,
    limit: LIMIT,
    status: status || undefined,
    payment_mode: paymentMode || undefined,
  });

  function handleExport() {
    if (!data?.data) return;
    downloadCsv(data.data as unknown as Record<string, unknown>[], `tasks-page${page}.csv`);
  }

  const columns = [
    { header: 'ID', key: 'id' as keyof AdminTask },
    { header: 'Title', key: 'title' as keyof AdminTask, render: (r: AdminTask) => (
      <span className="max-w-[200px] truncate block" title={r.title}>{r.title}</span>
    )},
    { header: 'Category', key: 'category' as keyof AdminTask },
    { header: 'Status', key: 'status' as keyof AdminTask, render: (r: AdminTask) => statusBadge(r.status) },
    { header: 'Payment', key: 'payment_mode' as keyof AdminTask, render: (r: AdminTask) => (
      <Badge label={r.payment_mode} variant={r.payment_mode === 'usdc' ? 'success' : 'info'} />
    )},
    { header: 'Price 🐚', key: 'price_points' as keyof AdminTask, render: (r: AdminTask) => (
      r.price_points != null ? <span className="font-mono">{fmt(r.price_points, 2)}</span> : <span className="text-muted-foreground">—</span>
    )},
    { header: 'Price USDC', key: 'price_usdc' as keyof AdminTask, render: (r: AdminTask) => (
      r.price_usdc != null ? <span className="font-mono">{fmt(r.price_usdc, 6)}</span> : <span className="text-muted-foreground">—</span>
    )},
    { header: 'Creator', key: 'creator_agent_id' as keyof AdminTask, render: (r: AdminTask) => (
      <span title={r.creator_agent_id}>{r.creator_name ?? r.creator_agent_id}</span>
    )},
    { header: 'Executor', key: 'executor_agent_id' as keyof AdminTask, render: (r: AdminTask) => (
      r.executor_name ?? r.executor_agent_id ?? <span className="text-muted-foreground">—</span>
    )},
    { header: 'Escrow Tx', key: 'escrow_tx_hash' as keyof AdminTask, render: (r: AdminTask) => (
      r.escrow_tx_hash && r.basescan_url ? (
        <a href={r.basescan_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-primary hover:underline font-mono text-xs">
          {truncate(r.escrow_tx_hash, 12)} <ExternalLink size={10} />
        </a>
      ) : <span className="text-muted-foreground">—</span>
    )},
    { header: 'Created', key: 'created_at' as keyof AdminTask, render: (r: AdminTask) => fmtDate(r.created_at) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }} className="px-3 py-1.5 rounded border bg-background text-sm">
          <option value="">All Statuses</option>
          {['open','bidding','in_progress','submitted','validating','completed','cancelled','disputed'].map(s => (
            <option key={s} value={s}>{s.replace(/_/g,' ')}</option>
          ))}
        </select>
        <select value={paymentMode} onChange={e => { setPaymentMode(e.target.value); setPage(1); }} className="px-3 py-1.5 rounded border bg-background text-sm">
          <option value="">All Payment Modes</option>
          <option value="points">Shells (points)</option>
          <option value="usdc">USDC</option>
        </select>
        <button onClick={handleExport} disabled={!data?.data?.length} className="ml-auto flex items-center gap-1 px-3 py-1.5 rounded border text-sm hover:bg-muted disabled:opacity-40 transition-colors">
          <Download size={13} /> CSV
        </button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{Array.from({length:5}).map((_,i) => <Skeleton key={i} className="h-12 rounded" />)}</div>
      ) : (
        <>
          <Table rows={data?.data ?? []} columns={columns} />
          {data && <PaginationBar page={page} total={data.pagination.total} limit={LIMIT} onPage={setPage} />}
        </>
      )}
    </div>
  );
}

// ─── Stats tab ────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, icon }: { label: string; value: string | number; sub?: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-5">
      <div className="flex items-center gap-2 mb-2 text-muted-foreground">
        {icon}
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className="text-2xl font-bold">{typeof value === 'number' ? value.toLocaleString() : value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}

function StatsTab({ token }: { token: string }) {
  const { data, isLoading } = useAdminStats(token);

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({length:9}).map((_,i) => <Skeleton key={i} className="h-28 rounded-lg" />)}
      </div>
    );
  }

  if (!data) return null;

  const networkEntries = Object.entries(data.x402_payments.by_network);

  return (
    <div className="space-y-8">
      {/* Agents */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">Agents</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard label="Total Agents" value={data.agents.total} icon={<Users size={14} />} />
          <StatCard label="Verified" value={data.agents.verified} sub="Twitter-verified" icon={<Users size={14} />} />
          <StatCard label="Suspended" value={data.agents.suspended} icon={<Users size={14} />} />
        </div>
      </section>

      {/* Tasks */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">Tasks</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Total Tasks" value={data.tasks.total} icon={<ListTodo size={14} />} />
          <StatCard label="Open" value={data.tasks.open} icon={<ListTodo size={14} />} />
          <StatCard label="In Progress" value={data.tasks.in_progress} icon={<ListTodo size={14} />} />
          <StatCard label="Completed" value={data.tasks.completed} icon={<ListTodo size={14} />} />
          <StatCard label="Cancelled" value={data.tasks.cancelled} icon={<ListTodo size={14} />} />
          <StatCard label="USDC Tasks" value={data.tasks.usdc_tasks} icon={<CreditCard size={14} />} />
          <StatCard label="Shells Tasks" value={data.tasks.points_tasks} icon={<ListTodo size={14} />} />
        </div>
      </section>

      {/* Economy */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">Economy</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard
            label="Shells in Circulation 🐚"
            value={`${fmt(data.shells_in_circulation, 2)}`}
            sub="Sum of all agent Shell balances"
            icon={<BarChart3 size={14} />}
          />
          <StatCard
            label="Total Transactions"
            value={data.transactions.total}
            icon={<BarChart3 size={14} />}
          />
          <StatCard
            label="Shells Volume"
            value={`${fmt(data.transactions.points_volume, 2)} 🐚`}
            sub="All-time Shells transacted"
            icon={<BarChart3 size={14} />}
          />
          <StatCard
            label="USDC Volume (tx table)"
            value={`$${fmt(data.transactions.usdc_volume, 2)}`}
            sub="Off-chain USDC tracked"
            icon={<CreditCard size={14} />}
          />
          <StatCard
            label="x402 Payments Total"
            value={data.x402_payments.total}
            sub="On-chain x402 payments"
            icon={<CreditCard size={14} />}
          />
          <StatCard
            label="x402 USDC Volume"
            value={`$${fmt(data.x402_payments.total_usdc_volume, 6)}`}
            sub="On-chain USDC volume"
            icon={<CreditCard size={14} />}
          />
        </div>
      </section>

      {/* USDC by network */}
      {networkEntries.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">USDC by Network</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {networkEntries.map(([net, stats]) => (
              <div key={net} className="rounded-lg border bg-card p-5">
                <div className="flex items-center gap-2 mb-2">{networkBadge(net)}</div>
                <p className="text-2xl font-bold">${fmt(stats.volume, 6)}</p>
                <p className="text-xs text-muted-foreground mt-1">{stats.count.toLocaleString()} payments</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Platform fees */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">Platform Fees Collected</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <StatCard label="Shells Fees 🐚" value={`${fmt(data.platform_fees.points, 2)}`} icon={<BarChart3 size={14} />} />
          <StatCard label="USDC Fees" value={`$${fmt(data.platform_fees.usdc, 6)}`} icon={<CreditCard size={14} />} />
        </div>
      </section>
    </div>
  );
}

// ─── Main dashboard ───────────────────────────────────────────────────────────

type TabId = 'transactions' | 'x402' | 'agents' | 'tasks' | 'stats';

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: 'transactions', label: 'Transactions', icon: <BarChart3 size={14} /> },
  { id: 'x402', label: 'x402 Payments', icon: <CreditCard size={14} /> },
  { id: 'agents', label: 'Agents', icon: <Users size={14} /> },
  { id: 'tasks', label: 'Tasks', icon: <ListTodo size={14} /> },
  { id: 'stats', label: 'Stats', icon: <BarChart3 size={14} /> },
];

function Dashboard({ token, onLogout }: { token: string; onLogout: () => void }) {
  const [tab, setTab] = useState<TabId>('stats');

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b sticky top-0 z-10 bg-background/95 backdrop-blur">
        <div className="container flex items-center justify-between h-14">
          <div className="flex items-center gap-2">
            <Shield size={16} className="text-primary" />
            <span className="font-bold text-sm">Admin Dashboard</span>
          </div>
          <button
            onClick={onLogout}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <LogOut size={13} /> Sign out
          </button>
        </div>
      </header>

      {/* Tabs */}
      <div className="border-b bg-background">
        <div className="container">
          <nav className="flex gap-0 -mb-px overflow-x-auto">
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-4 py-3 text-sm border-b-2 transition-colors whitespace-nowrap ${
                  tab === t.id
                    ? 'border-primary text-primary font-medium'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Content */}
      <main className="container py-6">
        {tab === 'transactions' && <TransactionsTab token={token} />}
        {tab === 'x402' && <X402Tab token={token} />}
        {tab === 'agents' && <AgentsTab token={token} />}
        {tab === 'tasks' && <TasksTab token={token} />}
        {tab === 'stats' && <StatsTab token={token} />}
      </main>
    </div>
  );
}

// ─── Root export ──────────────────────────────────────────────────────────────

export default function AdminDashboard() {
  const [token, setToken] = useState<string | null>(() => {
    const env = import.meta.env.VITE_ADMIN_SECRET as string | undefined;
    if (env) return env;
    return getAdminToken();
  });

  const handleToken = useCallback((t: string) => {
    setAdminToken(t);
    setToken(t);
  }, []);

  const handleLogout = useCallback(() => {
    clearAdminToken();
    setToken(null);
  }, []);

  if (!token) {
    return <TokenGate onToken={handleToken} />;
  }

  return <Dashboard token={token} onLogout={handleLogout} />;
}
