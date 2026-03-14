/**
 * Admin Dashboard — protected by VITE_ADMIN_SECRET (or session-entered token).
 * Route: /admin
 */

import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
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
  useAdminRecurringTemplates,
  useAdminRecurringInstances,
  adminToggleRecurringTemplate,
  adminTriggerRecurringTemplate,
  adminUpdateRecurringTemplate,
  adminCreateRecurringTemplate,
  type AdminTransaction,
  type AdminX402Payment,
  type AdminAgent,
  type AdminTask,
  type AdminRecurringTemplate,
  type AdminRecurringInstance,
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
  RefreshCw,
  Play,
  ToggleLeft,
  ToggleRight,
  Clock,
  X,
  Check,
  Pencil,
  Plus,
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

// ─── Recurring Tasks tab ──────────────────────────────────────────────────────

function modeBadge(mode: string) {
  const map: Record<string, 'success' | 'warning' | 'info' | 'default'> = {
    infinite: 'success',
    periodic: 'info',
    capped: 'warning',
  };
  return <Badge label={mode} variant={map[mode] ?? 'default'} />;
}

function validationBadge(vtype: string) {
  const map: Record<string, 'success' | 'warning' | 'info' | 'default'> = {
    auto: 'success',
    peer: 'info',
    link: 'warning',
    code: 'warning',
    combined: 'info',
  };
  return <Badge label={vtype} variant={map[vtype] ?? 'default'} />;
}

interface TemplateDetailProps {
  template: AdminRecurringTemplate;
  token: string;
  onClose: () => void;
  onUpdated: () => void;
}

function TemplateDetail({ template, token, onClose, onUpdated }: TemplateDetailProps) {
  const [instancePage, setInstancePage] = useState(1);
  const INSTANCE_LIMIT = 20;
  const { data: instanceData, isLoading: instancesLoading } = useAdminRecurringInstances(
    token,
    template.id,
    { page: instancePage, limit: INSTANCE_LIMIT },
  );

  const [triggerLoading, setTriggerLoading] = useState(false);
  const [triggerMsg, setTriggerMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  // Editable fields
  const [editTitle, setEditTitle] = useState(template.title_template);
  const [editDesc, setEditDesc] = useState(template.description_template);
  const [editCategory, setEditCategory] = useState(template.category);
  const [editPrice, setEditPrice] = useState(String(template.price_points));
  const [editMode, setEditMode] = useState(template.mode);
  const [editMaxConcurrent, setEditMaxConcurrent] = useState(String(template.max_concurrent));
  const [editMaxTotal, setEditMaxTotal] = useState(template.max_total != null ? String(template.max_total) : '');
  const [editCron, setEditCron] = useState(template.cron_expr ?? '');
  const [editTz, setEditTz] = useState(template.timezone ?? 'UTC');
  const [editValidationType, setEditValidationType] = useState(template.validation_type);
  const [editValidationConfig, setEditValidationConfig] = useState(
    template.validation_config ? JSON.stringify(template.validation_config, null, 2) : '{}',
  );
  const [editPosterAgent, setEditPosterAgent] = useState(template.poster_agent_id ?? '');
  const [saveLoading, setSaveLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function handleTrigger() {
    setTriggerLoading(true);
    setTriggerMsg(null);
    try {
      const res = await adminTriggerRecurringTemplate(token, template.id);
      setTriggerMsg(`✅ Posted task ${res.task_id}`);
      onUpdated();
    } catch (err) {
      setTriggerMsg(`❌ ${err instanceof Error ? err.message : 'Failed'}`);
    } finally {
      setTriggerLoading(false);
    }
  }

  async function handleSave() {
    setSaveLoading(true);
    setSaveError(null);
    try {
      let parsedConfig: Record<string, unknown> | null = null;
      try {
        parsedConfig = JSON.parse(editValidationConfig) as Record<string, unknown>;
      } catch {
        setSaveError('validation_config must be valid JSON');
        setSaveLoading(false);
        return;
      }

      await adminUpdateRecurringTemplate(token, template.id, {
        title_template: editTitle,
        description_template: editDesc,
        category: editCategory,
        price_points: parseInt(editPrice, 10),
        mode: editMode,
        max_concurrent: parseInt(editMaxConcurrent, 10),
        max_total: editMaxTotal ? parseInt(editMaxTotal, 10) : null,
        cron_expr: editCron || null,
        timezone: editTz,
        validation_type: editValidationType,
        validation_config: parsedConfig,
        poster_agent_id: editPosterAgent || undefined,
      });
      setEditing(false);
      onUpdated();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaveLoading(false);
    }
  }

  const instanceColumns = [
    { header: 'Instance ID', key: 'id' as keyof AdminRecurringInstance },
    { header: 'Task ID', key: 'task_id' as keyof AdminRecurringInstance, render: (r: AdminRecurringInstance) => (
      r.task_id ?? <span className="text-muted-foreground">—</span>
    )},
    { header: 'Task Title', key: 'task_title' as keyof AdminRecurringInstance, render: (r: AdminRecurringInstance) => (
      <span className="max-w-[180px] truncate block" title={r.task_title ?? undefined}>{r.task_title ?? '—'}</span>
    )},
    { header: 'Status', key: 'task_status' as keyof AdminRecurringInstance, render: (r: AdminRecurringInstance) => (
      r.task_status ? statusBadge(r.task_status) : <span className="text-muted-foreground">—</span>
    )},
    { header: 'Posted At', key: 'posted_at' as keyof AdminRecurringInstance, render: (r: AdminRecurringInstance) => fmtDate(r.posted_at) },
    { header: 'Variables', key: 'variables' as keyof AdminRecurringInstance, render: (r: AdminRecurringInstance) => (
      r.variables
        ? <span className="font-mono text-xs">{Object.entries(r.variables).map(([k,v]) => `${k}=${v}`).join(', ')}</span>
        : <span className="text-muted-foreground">—</span>
    )},
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-start justify-end" onClick={onClose}>
      <div
        className="h-full w-full max-w-2xl bg-background border-l shadow-xl overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-background border-b p-4 flex items-center justify-between z-10">
          <h2 className="font-bold text-base truncate max-w-[80%]">{template.title_template}</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-6">
          {/* Header badges */}
          <div className="flex items-center gap-2 flex-wrap">
            {modeBadge(template.mode)}
            {validationBadge(template.validation_type)}
            <Badge label={template.enabled ? 'enabled' : 'disabled'} variant={template.enabled ? 'success' : 'danger'} />
            <span className="text-sm text-muted-foreground">
              {template.open_instances}/{template.max_concurrent} open slots
            </span>
            {template.max_total != null && (
              <span className="text-sm text-muted-foreground">
                {template.completed_count}/{template.max_total} total completed
              </span>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={handleTrigger}
              disabled={triggerLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              <Play size={13} /> {triggerLoading ? 'Triggering…' : 'Trigger Now'}
            </button>
            <button
              onClick={() => setEditing(!editing)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded border text-sm hover:bg-muted transition-colors"
            >
              <Pencil size={13} /> {editing ? 'Cancel Edit' : 'Edit'}
            </button>
          </div>

          {triggerMsg && (
            <p className={`text-sm ${triggerMsg.startsWith('✅') ? 'text-green-600' : 'text-red-600'}`}>
              {triggerMsg}
            </p>
          )}

          {/* Edit form */}
          {editing ? (
            <div className="space-y-3 border rounded-lg p-4">
              <h3 className="text-sm font-semibold">Edit Template</h3>

              {saveError && <p className="text-sm text-destructive">{saveError}</p>}

              <div className="grid grid-cols-1 gap-3">
                <label className="block">
                  <span className="text-xs text-muted-foreground">Title Template</span>
                  <input value={editTitle} onChange={e => setEditTitle(e.target.value)}
                    className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
                </label>
                <label className="block">
                  <span className="text-xs text-muted-foreground">Description Template</span>
                  <textarea value={editDesc} onChange={e => setEditDesc(e.target.value)} rows={4}
                    className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary resize-y" />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-xs text-muted-foreground">Category</span>
                    <input value={editCategory} onChange={e => setEditCategory(e.target.value)}
                      className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
                  </label>
                  <label className="block">
                    <span className="text-xs text-muted-foreground">Price (Shells)</span>
                    <input type="number" value={editPrice} onChange={e => setEditPrice(e.target.value)}
                      className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
                  </label>
                  <label className="block">
                    <span className="text-xs text-muted-foreground">Mode</span>
                    <select value={editMode} onChange={e => setEditMode(e.target.value as AdminRecurringTemplate['mode'])}
                      className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary">
                      <option value="infinite">infinite</option>
                      <option value="periodic">periodic</option>
                      <option value="capped">capped</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs text-muted-foreground">Max Concurrent</span>
                    <input type="number" value={editMaxConcurrent} onChange={e => setEditMaxConcurrent(e.target.value)}
                      className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
                  </label>
                  {editMode === 'capped' && (
                    <label className="block">
                      <span className="text-xs text-muted-foreground">Max Total</span>
                      <input type="number" value={editMaxTotal} onChange={e => setEditMaxTotal(e.target.value)}
                        className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
                    </label>
                  )}
                  <label className="block">
                    <span className="text-xs text-muted-foreground">Cron Expression</span>
                    <input value={editCron} onChange={e => setEditCron(e.target.value)} placeholder="0 9 * * *"
                      className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary" />
                  </label>
                  <label className="block">
                    <span className="text-xs text-muted-foreground">Timezone</span>
                    <input value={editTz} onChange={e => setEditTz(e.target.value)}
                      className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
                  </label>
                  <label className="block">
                    <span className="text-xs text-muted-foreground">Validation Type</span>
                    <select value={editValidationType} onChange={e => setEditValidationType(e.target.value)}
                      className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary">
                      {['peer','auto','link','code','combined'].map(v => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs text-muted-foreground">Poster Agent ID</span>
                    <input value={editPosterAgent} onChange={e => setEditPosterAgent(e.target.value)}
                      className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary" />
                  </label>
                </div>
                <label className="block">
                  <span className="text-xs text-muted-foreground">Validation Config (JSON)</span>
                  <textarea value={editValidationConfig} onChange={e => setEditValidationConfig(e.target.value)} rows={4}
                    className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary resize-y" />
                </label>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={handleSave}
                  disabled={saveLoading}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-50 transition-colors"
                >
                  <Check size={13} /> {saveLoading ? 'Saving…' : 'Save Changes'}
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="px-3 py-1.5 rounded border text-sm hover:bg-muted transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            /* Read-only details */
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Category</p>
                <p className="font-medium">{template.category}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Price</p>
                <p className="font-medium font-mono">{template.price_points} 🐚</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Cron</p>
                <p className="font-medium font-mono">{template.cron_expr ?? '—'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Timezone</p>
                <p className="font-medium">{template.timezone ?? 'UTC'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Poster Agent</p>
                <p className="font-medium font-mono">{template.poster_agent_id ?? '—'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Pause Until</p>
                <p className="font-medium">{template.pause_until ? fmtDate(template.pause_until) : '—'}</p>
              </div>
              <div className="col-span-2">
                <p className="text-xs text-muted-foreground">Title Template</p>
                <p className="font-medium text-sm">{template.title_template}</p>
              </div>
              <div className="col-span-2">
                <p className="text-xs text-muted-foreground">Description Template</p>
                <p className="text-sm text-muted-foreground line-clamp-3">{template.description_template}</p>
              </div>
              {template.validation_config && (
                <div className="col-span-2">
                  <p className="text-xs text-muted-foreground">Validation Config</p>
                  <pre className="text-xs font-mono bg-muted p-2 rounded mt-1 overflow-x-auto">
                    {JSON.stringify(template.validation_config, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}

          {/* Instance history */}
          <div>
            <h3 className="text-sm font-semibold mb-2">Instance History</h3>
            {instancesLoading ? (
              <div className="space-y-2">{Array.from({length:3}).map((_,i) => <Skeleton key={i} className="h-10 rounded" />)}</div>
            ) : (
              <>
                <Table rows={instanceData?.data ?? []} columns={instanceColumns} />
                {instanceData && (
                  <PaginationBar
                    page={instancePage}
                    total={instanceData.pagination.total}
                    limit={INSTANCE_LIMIT}
                    onPage={setInstancePage}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface CreateTemplateFormProps {
  token: string;
  onCreated: () => void;
  onCancel: () => void;
}

function CreateTemplateForm({ token, onCreated, onCancel }: CreateTemplateFormProps) {
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [category, setCategory] = useState('content');
  const [price, setPrice] = useState('15');
  const [mode, setMode] = useState<'infinite' | 'periodic' | 'capped'>('periodic');
  const [maxConcurrent, setMaxConcurrent] = useState('1');
  const [maxTotal, setMaxTotal] = useState('');
  const [cron, setCron] = useState('');
  const [tz, setTz] = useState('UTC');
  const [validationType, setValidationType] = useState('peer');
  const [validationConfig, setValidationConfig] = useState('{}');
  const [posterAgent, setPosterAgent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      let parsedConfig: Record<string, unknown> | null = null;
      try {
        parsedConfig = JSON.parse(validationConfig) as Record<string, unknown>;
      } catch {
        setError('validation_config must be valid JSON');
        setLoading(false);
        return;
      }

      await adminCreateRecurringTemplate(token, {
        title_template: title,
        description_template: desc,
        category,
        price_points: parseInt(price, 10),
        mode,
        max_concurrent: parseInt(maxConcurrent, 10),
        max_total: maxTotal ? parseInt(maxTotal, 10) : null,
        cron_expr: cron || null,
        timezone: tz,
        validation_type: validationType,
        validation_config: parsedConfig,
        poster_agent_id: posterAgent || undefined,
        enabled: true,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="border rounded-lg p-4 space-y-3">
      <h3 className="text-sm font-semibold">New Recurring Template</h3>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-3">
        <label className="block">
          <span className="text-xs text-muted-foreground">Title Template *</span>
          <input required value={title} onChange={e => setTitle(e.target.value)} placeholder="Daily AI news — {{date}}"
            className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
        </label>
        <label className="block">
          <span className="text-xs text-muted-foreground">Description Template *</span>
          <textarea required value={desc} onChange={e => setDesc(e.target.value)} rows={3} placeholder="Describe the recurring task…"
            className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary resize-y" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-muted-foreground">Category</span>
            <select value={category} onChange={e => setCategory(e.target.value)}
              className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary">
              {['content','images','video','marketing','development','prototypes','analytics','validation'].map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-muted-foreground">Price (Shells)</span>
            <input required type="number" value={price} onChange={e => setPrice(e.target.value)}
              className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
          </label>
          <label className="block">
            <span className="text-xs text-muted-foreground">Mode</span>
            <select value={mode} onChange={e => setMode(e.target.value as 'infinite' | 'periodic' | 'capped')}
              className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary">
              <option value="infinite">infinite</option>
              <option value="periodic">periodic</option>
              <option value="capped">capped</option>
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-muted-foreground">Max Concurrent</span>
            <input type="number" value={maxConcurrent} onChange={e => setMaxConcurrent(e.target.value)}
              className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
          </label>
          {mode === 'capped' && (
            <label className="block">
              <span className="text-xs text-muted-foreground">Max Total</span>
              <input type="number" value={maxTotal} onChange={e => setMaxTotal(e.target.value)}
                className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
            </label>
          )}
          <label className="block">
            <span className="text-xs text-muted-foreground">Cron Expression</span>
            <input value={cron} onChange={e => setCron(e.target.value)} placeholder="0 9 * * *"
              className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary" />
          </label>
          <label className="block">
            <span className="text-xs text-muted-foreground">Timezone</span>
            <input value={tz} onChange={e => setTz(e.target.value)}
              className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
          </label>
          <label className="block">
            <span className="text-xs text-muted-foreground">Validation Type</span>
            <select value={validationType} onChange={e => setValidationType(e.target.value)}
              className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary">
              {['peer','auto','link','code','combined'].map(v => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-muted-foreground">Poster Agent ID</span>
            <input value={posterAgent} onChange={e => setPosterAgent(e.target.value)} placeholder="agt_…"
              className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary" />
          </label>
        </div>
        <label className="block">
          <span className="text-xs text-muted-foreground">Validation Config (JSON)</span>
          <textarea value={validationConfig} onChange={e => setValidationConfig(e.target.value)} rows={3}
            className="mt-0.5 w-full rounded border bg-background px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary resize-y" />
        </label>
        <div className="flex gap-2">
          <button type="submit" disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-50 transition-colors">
            <Plus size={13} /> {loading ? 'Creating…' : 'Create Template'}
          </button>
          <button type="button" onClick={onCancel}
            className="px-3 py-1.5 rounded border text-sm hover:bg-muted transition-colors">
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function RecurringTasksTab({ token }: { token: string }) {
  const [page, setPage] = useState(1);
  const LIMIT = 50;
  const queryClient = useQueryClient();

  const { data, isLoading, refetch } = useAdminRecurringTemplates(token, { page, limit: LIMIT });

  const [selectedTemplate, setSelectedTemplate] = useState<AdminRecurringTemplate | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  async function handleToggle(template: AdminRecurringTemplate) {
    setTogglingId(template.id);
    try {
      await adminToggleRecurringTemplate(token, template.id, !template.enabled);
      await queryClient.invalidateQueries({ queryKey: ['admin-recurring-templates'] });
      refetch().catch(() => {});
    } catch (err) {
      console.error('Toggle failed:', err);
    } finally {
      setTogglingId(null);
    }
  }

  function handleUpdated() {
    queryClient.invalidateQueries({ queryKey: ['admin-recurring-templates'] }).catch(() => {});
    refetch().catch(() => {});
  }

  const columns = [
    {
      header: 'Title Template',
      key: 'title_template' as keyof AdminRecurringTemplate,
      render: (r: AdminRecurringTemplate) => (
        <button
          onClick={() => setSelectedTemplate(r)}
          className="text-left text-primary hover:underline max-w-[200px] truncate block"
          title={r.title_template}
        >
          {r.title_template}
        </button>
      ),
    },
    { header: 'Mode', key: 'mode' as keyof AdminRecurringTemplate, render: (r: AdminRecurringTemplate) => modeBadge(r.mode) },
    {
      header: 'Slots',
      key: 'open_instances' as keyof AdminRecurringTemplate,
      render: (r: AdminRecurringTemplate) => (
        <span className={`font-mono text-sm ${r.open_instances >= r.max_concurrent ? 'text-green-600' : 'text-yellow-600'}`}>
          {r.open_instances}/{r.max_concurrent} open
        </span>
      ),
    },
    { header: 'Cron', key: 'cron_expr' as keyof AdminRecurringTemplate, render: (r: AdminRecurringTemplate) => (
      r.cron_expr
        ? <span className="font-mono text-xs flex items-center gap-1"><Clock size={10} /> {r.cron_expr}</span>
        : <span className="text-muted-foreground">—</span>
    )},
    { header: 'Validation', key: 'validation_type' as keyof AdminRecurringTemplate, render: (r: AdminRecurringTemplate) => validationBadge(r.validation_type) },
    { header: 'Category', key: 'category' as keyof AdminRecurringTemplate },
    { header: 'Price 🐚', key: 'price_points' as keyof AdminRecurringTemplate, render: (r: AdminRecurringTemplate) => (
      <span className="font-mono">{r.price_points}</span>
    )},
    {
      header: 'Enabled',
      key: 'enabled' as keyof AdminRecurringTemplate,
      render: (r: AdminRecurringTemplate) => (
        <button
          onClick={() => handleToggle(r)}
          disabled={togglingId === r.id}
          className="flex items-center gap-1 text-sm hover:opacity-70 transition-opacity disabled:opacity-40"
          title={r.enabled ? 'Click to disable' : 'Click to enable'}
        >
          {togglingId === r.id ? (
            <RefreshCw size={14} className="animate-spin" />
          ) : r.enabled ? (
            <ToggleRight size={16} className="text-green-600" />
          ) : (
            <ToggleLeft size={16} className="text-muted-foreground" />
          )}
          {r.enabled ? 'On' : 'Off'}
        </button>
      ),
    },
    {
      header: 'Trigger',
      key: 'id' as keyof AdminRecurringTemplate,
      render: (r: AdminRecurringTemplate) => (
        <button
          onClick={() => setSelectedTemplate(r)}
          className="flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <Play size={11} /> Open
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Recurring Templates</h2>
        <div className="flex gap-2">
          <button
            onClick={() => refetch()}
            className="flex items-center gap-1 px-3 py-1.5 rounded border text-sm hover:bg-muted transition-colors"
          >
            <RefreshCw size={13} /> Refresh
          </button>
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="flex items-center gap-1 px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm hover:bg-primary/90 transition-colors"
          >
            <Plus size={13} /> New Template
          </button>
        </div>
      </div>

      {showCreate && (
        <CreateTemplateForm
          token={token}
          onCreated={() => {
            setShowCreate(false);
            handleUpdated();
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {isLoading ? (
        <div className="space-y-2">{Array.from({length:6}).map((_,i) => <Skeleton key={i} className="h-12 rounded" />)}</div>
      ) : (
        <>
          <Table rows={data?.data ?? []} columns={columns} />
          {data && (
            <PaginationBar page={page} total={data.pagination.total} limit={LIMIT} onPage={setPage} />
          )}
        </>
      )}

      {selectedTemplate && (
        <TemplateDetail
          template={selectedTemplate}
          token={token}
          onClose={() => setSelectedTemplate(null)}
          onUpdated={() => {
            handleUpdated();
            // Update selected template from fresh data if available
          }}
        />
      )}
    </div>
  );
}

// ─── Main dashboard ───────────────────────────────────────────────────────────

type TabId = 'transactions' | 'x402' | 'agents' | 'tasks' | 'stats' | 'recurring';

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: 'transactions', label: 'Transactions', icon: <BarChart3 size={14} /> },
  { id: 'x402', label: 'x402 Payments', icon: <CreditCard size={14} /> },
  { id: 'agents', label: 'Agents', icon: <Users size={14} /> },
  { id: 'tasks', label: 'Tasks', icon: <ListTodo size={14} /> },
  { id: 'stats', label: 'Stats', icon: <BarChart3 size={14} /> },
  { id: 'recurring', label: 'Recurring Tasks', icon: <RefreshCw size={14} /> },
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
        {tab === 'recurring' && <RecurringTasksTab token={token} />}
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
