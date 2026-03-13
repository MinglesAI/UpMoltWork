import { useParams, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useAgentProfile, useAgentTasks } from '@/api/queries';
import StatusBadge from '@/components/shared/StatusBadge';
import ReputationBadge from '@/components/shared/ReputationBadge';
import TaskCard from '@/components/shared/TaskCard';
import { Skeleton } from '@/components/ui/skeleton';

export default function AgentProfile() {
  const { agentId } = useParams<{ agentId: string }>();
  const { data: agent, isLoading, error } = useAgentProfile(agentId);
  const { data: agentTasks } = useAgentTasks(agentId, { limit: 10 });

  if (isLoading) {
    return (
      <div className="container py-8 max-w-3xl">
        <Skeleton className="h-8 w-48 mb-6" />
        <Skeleton className="h-48 rounded-lg" />
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="container py-8">
        <p className="text-muted-foreground">Agent not found.</p>
        <Link to="/agents" className="text-sm text-primary mt-2 inline-block">← Back to agents</Link>
      </div>
    );
  }

  return (
    <div className="container py-8 max-w-3xl">
      <Link to="/agents" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors">
        <ArrowLeft size={14} /> Back to agents
      </Link>

      <div className="rounded-lg border bg-card p-6 mb-6">
        {/* Avatar stub */}
        <div className="flex items-start gap-4 mb-4">
          <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center text-2xl font-bold text-muted-foreground">
            {agent.name.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-xl font-bold">{agent.name}</h1>
              <StatusBadge status={agent.status} />
            </div>
            <ReputationBadge score={agent.reputation_score} className="text-sm" />
          </div>
        </div>

        {agent.description && (
          <p className="text-sm text-muted-foreground mb-4 whitespace-pre-wrap">{agent.description}</p>
        )}

        <div className="grid grid-cols-3 gap-4 text-center border-t pt-4">
          <div>
            <p className="text-lg font-bold">{agent.tasks_completed ?? 0}</p>
            <p className="text-xs text-muted-foreground">Completed</p>
          </div>
          <div>
            <p className="text-lg font-bold">{agent.tasks_created ?? 0}</p>
            <p className="text-xs text-muted-foreground">Created</p>
          </div>
          <div>
            <p className="text-lg font-bold">{parseFloat(String(agent.success_rate ?? 0)).toFixed(0)}%</p>
            <p className="text-xs text-muted-foreground">Success Rate</p>
          </div>
        </div>

        {agent.specializations && agent.specializations.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {agent.specializations.map(s => (
              <span key={s} className="bg-muted px-2 py-1 rounded text-xs capitalize">{s}</span>
            ))}
          </div>
        )}
      </div>

      {/* Tasks */}
      {agentTasks && agentTasks.tasks.length > 0 && (
        <div>
          <h2 className="font-semibold mb-3">Recent Tasks</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {agentTasks.tasks.map(t => <TaskCard key={t.id} task={t} />)}
          </div>
        </div>
      )}
    </div>
  );
}
