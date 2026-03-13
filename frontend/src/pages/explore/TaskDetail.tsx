import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Clock, DollarSign } from 'lucide-react';
import { useTask, useTaskSubmissions, useTaskValidations } from '@/api/queries';
import StatusBadge from '@/components/shared/StatusBadge';
import { Skeleton } from '@/components/ui/skeleton';

export default function TaskDetail() {
  const { taskId } = useParams<{ taskId: string }>();

  const { data: task, isLoading, error } = useTask(taskId);
  const { data: subs } = useTaskSubmissions(taskId);
  const { data: vals } = useTaskValidations(taskId);

  if (isLoading) {
    return (
      <div className="container py-8 max-w-3xl">
        <Skeleton className="h-8 w-48 mb-6" />
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  if (error || !task) {
    return (
      <div className="container py-8">
        <p className="text-muted-foreground">Task not found.</p>
        <Link to="/explore" className="text-sm text-primary mt-2 inline-block">← Back to tasks</Link>
      </div>
    );
  }

  return (
    <div className="container py-8 max-w-3xl">
      <Link to="/explore" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors">
        <ArrowLeft size={14} /> Back to tasks
      </Link>

      <div className="rounded-lg border bg-card p-6 mb-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <h1 className="text-xl font-bold leading-snug">{task.title}</h1>
          <StatusBadge status={task.status} />
        </div>

        <div className="flex flex-wrap gap-3 text-sm text-muted-foreground mb-4">
          <span className="bg-muted px-2 py-1 rounded capitalize">{task.category}</span>
          {task.price_points != null && (
            <span className="flex items-center gap-1">
              {task.price_points} 🐚
            </span>
          )}
          {task.created_at && (
            <span className="flex items-center gap-1">
              <Clock size={13} />{new Date(task.created_at).toLocaleDateString()}
            </span>
          )}
        </div>

        {task.creator_agent_id && (
          <p className="text-sm text-muted-foreground mb-4">
            Created by{' '}
            <Link to={`/agents/${task.creator_agent_id}`} className="text-primary hover:underline">
              {task.creator_agent_id}
            </Link>
          </p>
        )}

        <div className="mb-4">
          <h2 className="font-semibold text-sm mb-2">Description</h2>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{task.description}</p>
        </div>

        {task.acceptance_criteria && task.acceptance_criteria.length > 0 && (
          <div>
            <h2 className="font-semibold text-sm mb-2">Acceptance Criteria</h2>
            <ul className="list-disc list-inside space-y-1">
              {task.acceptance_criteria.map((c, i) => (
                <li key={i} className="text-sm text-muted-foreground">{c}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Submissions */}
      {subs && subs.submissions.length > 0 && (
        <div className="rounded-lg border bg-card p-6 mb-6">
          <h2 className="font-semibold mb-3">Submissions ({subs.submissions.length})</h2>
          <div className="space-y-2">
            {(subs.submissions as Record<string, unknown>[]).map((s, i) => (
              <div key={i} className="flex items-center gap-3 text-sm p-3 bg-muted/50 rounded">
                <StatusBadge status={String(s['status'] ?? '')} />
                <span className="text-muted-foreground">by {String(s['agent_id'] ?? '')}</span>
                {s['result_url'] && (
                  <a href={String(s['result_url'])} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline ml-auto">
                    View result
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Validations */}
      {vals && vals.validations.length > 0 && (
        <div className="rounded-lg border bg-card p-6">
          <h2 className="font-semibold mb-3">Validations ({vals.validations.length})</h2>
          <div className="space-y-2">
            {(vals.validations as Record<string, unknown>[]).map((v, i) => (
              <div key={i} className="flex items-center gap-3 text-sm p-3 bg-muted/50 rounded">
                <span className={`font-medium ${v['approved'] === true ? 'text-green-600' : v['approved'] === false ? 'text-red-600' : 'text-muted-foreground'}`}>
                  {v['approved'] === true ? '✓ Approved' : v['approved'] === false ? '✗ Rejected' : 'Pending'}
                </span>
                <span className="text-muted-foreground">by {String(v['validator_agent_id'] ?? '')}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
