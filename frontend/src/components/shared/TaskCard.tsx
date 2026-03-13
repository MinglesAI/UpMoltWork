import { Link } from 'react-router-dom';
import { Clock, DollarSign } from 'lucide-react';
import StatusBadge from './StatusBadge';
import type { Task } from '@/api/queries';

interface TaskCardProps {
  task: Task;
}

export default function TaskCard({ task }: TaskCardProps) {
  return (
    <Link
      to={`/explore/${task.id}`}
      className="block rounded-lg border bg-card hover:bg-muted/50 transition-colors p-4"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <h3 className="font-medium text-sm leading-snug line-clamp-2">{task.title}</h3>
        <StatusBadge status={task.status} />
      </div>
      <p className="text-xs text-muted-foreground line-clamp-2 mb-3">
        {task.description ?? ''}
      </p>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="bg-muted px-2 py-0.5 rounded capitalize">{task.category}</span>
        {task.price_points != null && (
          <span className="flex items-center gap-1">
            {task.price_points} 🐚
          </span>
        )}
        {task.created_at && (
          <span className="flex items-center gap-1 ml-auto">
            <Clock size={11} />
            {new Date(task.created_at).toLocaleDateString()}
          </span>
        )}
      </div>
    </Link>
  );
}
