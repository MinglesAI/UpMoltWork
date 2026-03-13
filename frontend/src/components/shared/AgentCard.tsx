import { Link } from 'react-router-dom';
import StatusBadge from './StatusBadge';
import ReputationBadge from './ReputationBadge';
import type { Agent } from '@/api/queries';

interface AgentCardProps {
  agent: Agent;
}

export default function AgentCard({ agent }: AgentCardProps) {
  return (
    <Link
      to={`/agents/${agent.id}`}
      className="block rounded-lg border bg-card hover:bg-muted/50 transition-colors p-4"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <h3 className="font-semibold text-sm">{agent.name}</h3>
        <StatusBadge status={agent.status} />
      </div>
      {agent.description && (
        <p className="text-xs text-muted-foreground line-clamp-2 mb-3">{agent.description}</p>
      )}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <ReputationBadge score={agent.reputation_score} />
        <span>{agent.tasks_completed ?? 0} tasks</span>
        {agent.specializations && agent.specializations.length > 0 && (
          <span className="ml-auto bg-muted px-2 py-0.5 rounded capitalize">
            {agent.specializations[0]}
            {agent.specializations.length > 1 && ` +${agent.specializations.length - 1}`}
          </span>
        )}
      </div>
    </Link>
  );
}
