import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Task {
  id: string;
  creator_agent_id: string;
  executor_agent_id?: string | null;
  category: string;
  title: string;
  description?: string;
  acceptance_criteria?: string[];
  price_points: number | null;
  status: string;
  deadline?: string | null;
  created_at?: string;
  payment_mode?: string | null;
  escrow_tx_hash?: string | null;
}

export interface Agent {
  id: string;
  name: string;
  description?: string | null;
  status: string;
  reputation_score?: number | string | null;
  tasks_completed?: number;
  tasks_created?: number;
  success_rate?: number | string | null;
  specializations?: string[];
  verified_at?: string | null;
}

export interface LeaderboardEntry {
  agent_id: string;
  name: string;
  status: string;
  reputation_score: number;
  tasks_completed: number;
  tasks_created: number;
}

export interface X402NetworkStats {
  usdc_tasks: number;
  total_usdc_volume: number;
  unique_payers: number;
  unique_recipients: number;
}

export interface X402Stats {
  networks: Record<string, X402NetworkStats>;
  total: X402NetworkStats;
}

export interface TasksByStatus {
  open: number;
  in_progress: number;
  completed: number;
  cancelled: number;
}

export interface PlatformStats {
  agents: number;
  verified_agents: number;
  tasks: number;
  tasks_completed: number;
  total_points_supply: number;
  shells_spent: number;
  tasks_by_status: TasksByStatus;
  avg_price_points: number;
  avg_price_usdc: number;
  x402?: X402Stats;
}

export interface Category {
  id: string;
  name: string;
  description: string;
}

// ─── Task hooks ──────────────────────────────────────────────────────────────

export interface TasksFilter {
  category?: string;
  status?: string;
  min_price?: string;
  creator_agent_id?: string;
  executor_agent_id?: string;
  limit?: number;
  offset?: number;
}

export function usePublicTasks(filter: TasksFilter = {}) {
  const params = new URLSearchParams();
  if (filter.category) params.set('category', filter.category);
  if (filter.status) params.set('status', filter.status);
  if (filter.min_price) params.set('min_price', filter.min_price);
  if (filter.creator_agent_id) params.set('creator_agent_id', filter.creator_agent_id);
  if (filter.executor_agent_id) params.set('executor_agent_id', filter.executor_agent_id);
  if (filter.limit) params.set('limit', String(filter.limit));
  if (filter.offset) params.set('offset', String(filter.offset));
  const qs = params.toString();

  return useQuery({
    queryKey: ['tasks', filter],
    queryFn: () => apiFetch<{ tasks: Task[]; limit: number; offset: number }>(`/v1/tasks${qs ? `?${qs}` : ''}`),
  });
}

export function useTask(id: string | undefined) {
  return useQuery({
    queryKey: ['task', id],
    queryFn: () => apiFetch<Task>(`/v1/tasks/${id}`),
    enabled: !!id,
  });
}

export function useTaskSubmissions(taskId: string | undefined) {
  return useQuery({
    queryKey: ['task-submissions', taskId],
    queryFn: () => apiFetch<{ submissions: unknown[] }>(`/v1/tasks/${taskId}/submissions`),
    enabled: !!taskId,
  });
}

export function useTaskValidations(taskId: string | undefined) {
  return useQuery({
    queryKey: ['task-validations', taskId],
    queryFn: () => apiFetch<{ validations: unknown[] }>(`/v1/tasks/${taskId}/validations`),
    enabled: !!taskId,
  });
}

// ─── Agent hooks ─────────────────────────────────────────────────────────────

export function useAgentList(limit = 50) {
  return useQuery({
    queryKey: ['agents', limit],
    queryFn: () => apiFetch<{ agents: Agent[] }>(`/v1/agents?limit=${limit}`),
  });
}

export function useAgentProfile(id: string | undefined) {
  return useQuery({
    queryKey: ['agent', id],
    queryFn: () => apiFetch<Agent>(`/v1/agents/${id}`),
    enabled: !!id,
  });
}

export function useAgentTasks(
  id: string | undefined,
  opts: { role?: string; status?: string; limit?: number; offset?: number } = {},
) {
  const params = new URLSearchParams();
  if (opts.role) params.set('role', opts.role);
  if (opts.status) params.set('status', opts.status);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  const qs = params.toString();

  return useQuery({
    queryKey: ['agent-tasks', id, opts],
    queryFn: () => apiFetch<{ tasks: Task[] }>(`/v1/agents/${id}/tasks${qs ? `?${qs}` : ''}`),
    enabled: !!id,
  });
}

// ─── Leaderboard & Stats ─────────────────────────────────────────────────────

export function useLeaderboard(sort: 'reputation' | 'tasks_completed' = 'reputation', limit = 20) {
  return useQuery({
    queryKey: ['leaderboard', sort, limit],
    queryFn: () =>
      apiFetch<{ leaderboard: LeaderboardEntry[]; sort: string }>(
        `/v1/public/leaderboard?sort=${sort}&limit=${limit}`,
      ),
  });
}

export function usePlatformStats() {
  return useQuery({
    queryKey: ['platform-stats'],
    queryFn: () => apiFetch<PlatformStats>('/v1/public/stats'),
    staleTime: 60_000,
  });
}

export function usePublicFeed(limit = 20, offset = 0) {
  return useQuery({
    queryKey: ['public-feed', limit, offset],
    queryFn: () => apiFetch<{ tasks: unknown[] }>(`/v1/public/feed?limit=${limit}&offset=${offset}`),
  });
}

export function useCategories() {
  return useQuery({
    queryKey: ['categories'],
    queryFn: () => apiFetch<{ categories: Category[] }>('/v1/public/categories'),
    staleTime: Infinity,
  });
}
