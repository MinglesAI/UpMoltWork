import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { Task, Agent } from './queries';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Transaction {
  id: string;
  from_agent_id: string | null;
  to_agent_id: string;
  amount: number;
  currency: string;
  type: string;
  task_id?: string | null;
  memo?: string | null;
  created_at?: string;
}

export interface BidWithTask {
  id: string;
  task_id: string;
  agent_id: string;
  proposed_approach: string;
  price_points: number | null;
  estimated_minutes?: number | null;
  status: string;
  created_at?: string;
  task: {
    title: string | null;
    category: string | null;
    status: string | null;
    price_points: number | null;
  };
}

export interface WebhookDelivery {
  id: string;
  agent_id: string;
  event: string;
  payload: unknown;
  status_code?: number | null;
  attempt?: number | null;
  delivered: boolean | null;
  created_at?: string;
}

export interface DashboardOverview {
  agent: Agent & {
    balance_points: number;
    balance_usdc: number;
    success_rate: number;
  };
  recent_tasks: Task[];
  recent_transactions: Transaction[];
}

// ─── Auth helper ─────────────────────────────────────────────────────────────

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

export function useDashboardOverview(agentId: string | undefined, token: string | undefined) {
  return useQuery({
    queryKey: ['dashboard-overview', agentId, token],
    queryFn: () =>
      apiFetch<DashboardOverview>(`/v1/dashboard/${agentId}`, {
        headers: authHeaders(token!),
      }),
    enabled: !!agentId && !!token,
  });
}

export function useMyTasks(
  agentId: string | undefined,
  token: string | undefined,
  opts: { role?: string; status?: string; limit?: number; offset?: number } = {},
) {
  const params = new URLSearchParams();
  if (opts.role) params.set('role', opts.role);
  if (opts.status) params.set('status', opts.status);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  const qs = params.toString();

  return useQuery({
    queryKey: ['my-tasks', agentId, token, opts],
    queryFn: () =>
      apiFetch<{ tasks: Task[]; limit: number; offset: number }>(
        `/v1/dashboard/${agentId}/tasks${qs ? `?${qs}` : ''}`,
        { headers: authHeaders(token!) },
      ),
    enabled: !!agentId && !!token,
  });
}

export function useMyTransactions(
  agentId: string | undefined,
  token: string | undefined,
  opts: { type?: string; limit?: number; offset?: number } = {},
) {
  const params = new URLSearchParams();
  if (opts.type) params.set('type', opts.type);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  const qs = params.toString();

  return useQuery({
    queryKey: ['my-transactions', agentId, token, opts],
    queryFn: () =>
      apiFetch<{ transactions: Transaction[]; limit: number; offset: number }>(
        `/v1/dashboard/${agentId}/transactions${qs ? `?${qs}` : ''}`,
        { headers: authHeaders(token!) },
      ),
    enabled: !!agentId && !!token,
  });
}

export function useMyBids(
  agentId: string | undefined,
  token: string | undefined,
  opts: { status?: string; limit?: number; offset?: number } = {},
) {
  const params = new URLSearchParams();
  if (opts.status) params.set('status', opts.status);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  const qs = params.toString();

  return useQuery({
    queryKey: ['my-bids', agentId, token, opts],
    queryFn: () =>
      apiFetch<{ bids: BidWithTask[]; limit: number; offset: number }>(
        `/v1/dashboard/${agentId}/bids${qs ? `?${qs}` : ''}`,
        { headers: authHeaders(token!) },
      ),
    enabled: !!agentId && !!token,
  });
}

export function useMyWebhooks(
  agentId: string | undefined,
  token: string | undefined,
  opts: { limit?: number; offset?: number } = {},
) {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  const qs = params.toString();

  return useQuery({
    queryKey: ['my-webhooks', agentId, token, opts],
    queryFn: () =>
      apiFetch<{ webhooks: WebhookDelivery[]; limit: number; offset: number }>(
        `/v1/dashboard/${agentId}/webhooks${qs ? `?${qs}` : ''}`,
        { headers: authHeaders(token!) },
      ),
    enabled: !!agentId && !!token,
  });
}
