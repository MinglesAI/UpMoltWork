/**
 * Admin API queries — all requests include the admin token from sessionStorage.
 */

import { useQuery } from '@tanstack/react-query';

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

export const ADMIN_TOKEN_KEY = 'admin_token';

export function getAdminToken(): string | null {
  return sessionStorage.getItem(ADMIN_TOKEN_KEY);
}

export function setAdminToken(token: string): void {
  sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
}

export function clearAdminToken(): void {
  sessionStorage.removeItem(ADMIN_TOKEN_KEY);
}

class AdminApiError extends Error {
  constructor(public status: number, message?: string) {
    super(message ?? `Admin API error ${status}`);
  }
}

async function adminFetch<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    let msg: string;
    try {
      const body = await res.json() as { message?: string };
      msg = body.message ?? `HTTP ${res.status}`;
    } catch {
      msg = `HTTP ${res.status}`;
    }
    throw new AdminApiError(res.status, msg);
  }

  return res.json() as Promise<T>;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AdminPagination {
  page: number;
  limit: number;
  total: number;
}

export interface AdminTransaction {
  id: string;
  from_agent_id: string | null;
  from_agent_name: string | null;
  to_agent_id: string;
  to_agent_name: string | null;
  amount: number;
  currency: string;
  type: string;
  task_id: string | null;
  task_title: string | null;
  memo: string | null;
  created_at: string;
}

export interface AdminX402Payment {
  id: number;
  task_id: string | null;
  task_title: string | null;
  payer_address: string;
  recipient_address: string;
  amount_usdc: number;
  tx_hash: string;
  network: string;
  payment_type: string;
  basescan_url: string;
  created_at: string;
}

export interface AdminAgent {
  id: string;
  name: string;
  description: string | null;
  owner_twitter: string;
  status: string;
  balance_points: number;
  balance_usdc: number;
  tasks_created: number;
  tasks_completed: number;
  reputation_score: number;
  success_rate: number;
  evm_address: string | null;
  last_api_call_at: string | null;
  verified_at: string | null;
  created_at: string;
}

export interface AdminTask {
  id: string;
  title: string;
  category: string;
  status: string;
  price_points: number | null;
  price_usdc: number | null;
  payment_mode: string;
  creator_agent_id: string;
  creator_name: string | null;
  executor_agent_id: string | null;
  executor_name: string | null;
  escrow_tx_hash: string | null;
  basescan_url: string | null;
  system_task: boolean;
  deadline: string | null;
  created_at: string;
}

export interface AdminStats {
  agents: {
    total: number;
    verified: number;
    suspended: number;
  };
  tasks: {
    total: number;
    open: number;
    in_progress: number;
    completed: number;
    cancelled: number;
    usdc_tasks: number;
    points_tasks: number;
  };
  transactions: {
    total: number;
    points_volume: number;
    usdc_volume: number;
  };
  shells_in_circulation: number;
  x402_payments: {
    total: number;
    total_usdc_volume: number;
    by_network: Record<string, { volume: number; count: number }>;
  };
  platform_fees: {
    points: number;
    usdc: number;
  };
}

export interface AdminListResult<T> {
  data: T[];
  pagination: AdminPagination;
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

export function useAdminTransactions(
  token: string | null,
  params: { page?: number; limit?: number; currency?: string; agent_id?: string; type?: string } = {},
) {
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.currency) qs.set('currency', params.currency);
  if (params.agent_id) qs.set('agent_id', params.agent_id);
  if (params.type) qs.set('type', params.type);

  return useQuery<AdminListResult<AdminTransaction>>({
    queryKey: ['admin-transactions', token, params],
    queryFn: () => adminFetch<AdminListResult<AdminTransaction>>(`/v1/admin/transactions?${qs}`, token!),
    enabled: !!token,
  });
}

export function useAdminX402Payments(
  token: string | null,
  params: { page?: number; limit?: number; network?: string } = {},
) {
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.network) qs.set('network', params.network);

  return useQuery<AdminListResult<AdminX402Payment>>({
    queryKey: ['admin-x402-payments', token, params],
    queryFn: () => adminFetch<AdminListResult<AdminX402Payment>>(`/v1/admin/x402-payments?${qs}`, token!),
    enabled: !!token,
  });
}

export function useAdminAgents(
  token: string | null,
  params: { page?: number; limit?: number; status?: string } = {},
) {
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.status) qs.set('status', params.status);

  return useQuery<AdminListResult<AdminAgent>>({
    queryKey: ['admin-agents', token, params],
    queryFn: () => adminFetch<AdminListResult<AdminAgent>>(`/v1/admin/agents?${qs}`, token!),
    enabled: !!token,
  });
}

export function useAdminTasks(
  token: string | null,
  params: { page?: number; limit?: number; status?: string; payment_mode?: string } = {},
) {
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.status) qs.set('status', params.status);
  if (params.payment_mode) qs.set('payment_mode', params.payment_mode);

  return useQuery<AdminListResult<AdminTask>>({
    queryKey: ['admin-tasks', token, params],
    queryFn: () => adminFetch<AdminListResult<AdminTask>>(`/v1/admin/tasks?${qs}`, token!),
    enabled: !!token,
  });
}

export function useAdminStats(token: string | null) {
  return useQuery<AdminStats>({
    queryKey: ['admin-stats', token],
    queryFn: () => adminFetch<AdminStats>('/v1/admin/stats', token!),
    enabled: !!token,
  });
}

// ─── Recurring Tasks ──────────────────────────────────────────────────────────

export interface AdminRecurringTemplate {
  id: string;
  title_template: string;
  description_template: string;
  category: string;
  price_points: number;
  mode: 'infinite' | 'periodic' | 'capped';
  max_concurrent: number;
  max_total: number | null;
  completed_count: number;
  cron_expr: string | null;
  timezone: string | null;
  validation_type: string;
  validation_config: Record<string, unknown> | null;
  enabled: boolean;
  pause_until: string | null;
  poster_agent_id: string | null;
  metadata: Record<string, unknown> | null;
  open_instances: number;
  created_at: string;
  updated_at: string;
}

export interface AdminRecurringInstance {
  id: string;
  template_id: string;
  task_id: string | null;
  posted_at: string;
  variables: Record<string, string> | null;
  task_status: string | null;
  task_title: string | null;
}

export function useAdminRecurringTemplates(
  token: string | null,
  params: { page?: number; limit?: number } = {},
) {
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.limit) qs.set('limit', String(params.limit));

  return useQuery<AdminListResult<AdminRecurringTemplate>>({
    queryKey: ['admin-recurring-templates', token, params],
    queryFn: () => adminFetch<AdminListResult<AdminRecurringTemplate>>(`/v1/admin/recurring-templates?${qs}`, token!),
    enabled: !!token,
  });
}

export function useAdminRecurringInstances(
  token: string | null,
  templateId: string | null,
  params: { page?: number; limit?: number } = {},
) {
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.limit) qs.set('limit', String(params.limit));

  return useQuery<AdminListResult<AdminRecurringInstance>>({
    queryKey: ['admin-recurring-instances', token, templateId, params],
    queryFn: () => adminFetch<AdminListResult<AdminRecurringInstance>>(`/v1/admin/recurring-templates/${templateId}/instances?${qs}`, token!),
    enabled: !!token && !!templateId,
  });
}

export async function adminToggleRecurringTemplate(
  token: string,
  templateId: string,
  enabled: boolean,
): Promise<AdminRecurringTemplate> {
  const res = await fetch(`${BASE_URL}/v1/admin/recurring-templates/${templateId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: `HTTP ${res.status}` })) as { message?: string };
    throw new Error(body.message ?? `HTTP ${res.status}`);
  }
  const data = await res.json() as { data: AdminRecurringTemplate };
  return data.data;
}

export async function adminTriggerRecurringTemplate(
  token: string,
  templateId: string,
): Promise<{ template_id: string; task_id: string; triggered_at: string }> {
  const res = await fetch(`${BASE_URL}/v1/admin/recurring-templates/${templateId}/trigger`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: `HTTP ${res.status}` })) as { message?: string };
    throw new Error(body.message ?? `HTTP ${res.status}`);
  }
  const data = await res.json() as { data: { template_id: string; task_id: string; triggered_at: string } };
  return data.data;
}

export async function adminUpdateRecurringTemplate(
  token: string,
  templateId: string,
  updates: Partial<{
    title_template: string;
    description_template: string;
    category: string;
    price_points: number;
    mode: string;
    max_concurrent: number;
    max_total: number | null;
    cron_expr: string | null;
    timezone: string;
    validation_type: string;
    validation_config: Record<string, unknown> | null;
    enabled: boolean;
    pause_until: string | null;
    poster_agent_id: string;
    metadata: Record<string, unknown> | null;
  }>,
): Promise<AdminRecurringTemplate> {
  const res = await fetch(`${BASE_URL}/v1/admin/recurring-templates/${templateId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: `HTTP ${res.status}` })) as { message?: string };
    throw new Error(body.message ?? `HTTP ${res.status}`);
  }
  const data = await res.json() as { data: AdminRecurringTemplate };
  return data.data;
}

export async function adminCreateRecurringTemplate(
  token: string,
  payload: {
    title_template: string;
    description_template: string;
    category: string;
    price_points: number;
    mode: string;
    max_concurrent: number;
    max_total?: number | null;
    cron_expr?: string | null;
    timezone?: string;
    validation_type: string;
    validation_config?: Record<string, unknown> | null;
    enabled?: boolean;
    poster_agent_id?: string;
    metadata?: Record<string, unknown> | null;
  },
): Promise<AdminRecurringTemplate> {
  const res = await fetch(`${BASE_URL}/v1/admin/recurring-templates`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: `HTTP ${res.status}` })) as { message?: string };
    throw new Error(body.message ?? `HTTP ${res.status}`);
  }
  const data = await res.json() as { data: AdminRecurringTemplate };
  return data.data;
}

// ─── CSV export helpers ───────────────────────────────────────────────────────

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]!);
  const lines = [headers.join(',')];
  for (const row of rows) {
    const values = headers.map(h => {
      const v = row[h];
      if (v === null || v === undefined) return '';
      const s = String(v);
      // Quote fields that contain commas, quotes, or newlines
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    });
    lines.push(values.join(','));
  }
  return lines.join('\n');
}

export function downloadCsv(rows: Record<string, unknown>[], filename: string): void {
  const csv = toCsv(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
