'use client';

import type { CesiSession } from '@/lib/types';

export default function SessionSelect({ sessions, value, onChange, label = 'Session', allowAll = false }: {
  sessions: CesiSession[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
  allowAll?: boolean;
}) {
  return (
    <label className="block min-w-[240px]">
      <span className="form-label">{label}</span>
      <select className="form-input" value={value} onChange={(e) => onChange(e.target.value)}>
        {allowAll ? <option value="">Toutes les sessions</option> : null}
        {!allowAll && !value ? <option value="">Choisir…</option> : null}
        {sessions.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.analytic_code}</option>)}
      </select>
    </label>
  );
}
