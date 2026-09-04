import { cn } from '@/lib/utils';
import type { Grade, JuryOpinion } from '@/lib/types';
import { gradeTooltip, opinionLabel } from '@/lib/results';

export function GradeBadge({ grade, compact = false }: { grade: Grade | null | undefined; compact?: boolean }) {
  const value = grade?.final_mention || grade?.absence || '—';
  const klass = grade?.final_mention === 'A' ? 'grade-a'
    : grade?.final_mention === 'B' ? 'grade-b'
    : grade?.final_mention === 'C' ? 'grade-c'
    : grade?.final_mention === 'D' ? 'grade-d'
    : grade?.absence ? 'grade-absence'
    : 'grade-empty';
  return (
    <span
      title={gradeTooltip(grade)}
      className={cn('status-badge justify-center font-semibold', klass, compact ? 'min-w-8 px-2' : 'min-w-10')}
    >
      {value}{grade?.raw_mention?.includes('/') ? <sup className="ml-0.5 text-[8px]">↻</sup> : null}
    </span>
  );
}

export function OpinionBadge({ opinion }: { opinion: JuryOpinion | null }) {
  const klass = opinion === 'favorable' ? 'opinion-favorable'
    : opinion === 'reserve' ? 'opinion-reserve'
    : opinion === 'defavorable' ? 'opinion-defavorable'
    : 'grade-empty';
  return <span className={cn('status-badge', klass)}>{opinionLabel(opinion)}</span>;
}
