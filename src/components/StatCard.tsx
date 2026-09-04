import type { LucideIcon } from 'lucide-react';

export default function StatCard({ label, value, hint, icon: Icon }: { label: string; value: string | number; hint?: string; icon: LucideIcon }) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide muted">{label}</p>
          <p className="text-3xl font-semibold tracking-tight mt-2">{value}</p>
          {hint ? <p className="text-xs muted mt-1">{hint}</p> : null}
        </div>
        <div className="h-10 w-10 rounded-xl bg-blue-50 text-blue-600 grid place-items-center"><Icon size={20} /></div>
      </div>
    </div>
  );
}
