import { ChevronLeft, ChevronRight } from 'lucide-react';

interface PaginationProps {
  offset: number;
  limit: number;
  hasMore: boolean;
  onPrev: () => void;
  onNext: () => void;
}

export default function Pagination({ offset, limit, hasMore, onPrev, onNext }: PaginationProps) {
  const page = Math.floor(offset / limit) + 1;

  return (
    <div className="flex items-center justify-center gap-4 mt-6">
      <button
        onClick={onPrev}
        disabled={offset === 0}
        className="flex items-center gap-1 px-3 py-1.5 rounded border text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted transition-colors"
      >
        <ChevronLeft size={14} /> Prev
      </button>
      <span className="text-sm text-muted-foreground">Page {page}</span>
      <button
        onClick={onNext}
        disabled={!hasMore}
        className="flex items-center gap-1 px-3 py-1.5 rounded border text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted transition-colors"
      >
        Next <ChevronRight size={14} />
      </button>
    </div>
  );
}
