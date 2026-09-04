'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, RefreshCw, RotateCcw } from 'lucide-react';
import { getSupabaseBrowser } from '@/lib/supabase/client';
import type { CesiSession, Debt } from '@/lib/types';
import { displayStudent } from '@/lib/utils';
import SessionSelect from '@/components/SessionSelect';
import Loading from '@/components/Loading';
import Modal from '@/components/Modal';

export default function DettesPage() {
  const supabase = useMemo(() => getSupabaseBrowser(), []);
  const [sessions, setSessions] = useState<CesiSession[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [debts, setDebts] = useState<Debt[]>([]);
  const [status, setStatus] = useState<'all' | 'pending' | 'validated'>('all');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState<Debt | null>(null);

  const loadSessions = useCallback(async () => {
    const { data } = await supabase.from('sessions').select('*').order('name');
    const rows = (data || []) as CesiSession[];
    setSessions(rows);
    if (!sessionId && rows.length) setSessionId(rows[0].id);
  }, [supabase, sessionId]);

  const loadDebts = useCallback(async () => {
    if (!sessionId) { setLoading(false); return; }
    setLoading(true);
    const { data: studentRows } = await supabase.from('students').select('id').eq('session_id', sessionId);
    const ids = (studentRows || []).map((s) => s.id);
    if (!ids.length) { setDebts([]); setLoading(false); return; }
    let query = supabase.from('debts').select('*,students(id,first_name,last_name,session_id),ues(id,name,semester)').in('student_id', ids).order('created_at', { ascending: false });
    if (status !== 'all') query = query.eq('status', status);
    const { data } = await query;
    setDebts((data || []) as unknown as Debt[]);
    setLoading(false);
  }, [supabase, sessionId, status]);

  useEffect(() => { loadSessions(); }, [loadSessions]);
  useEffect(() => { loadDebts(); }, [loadDebts]);

  async function syncDebts() {
    if (!sessionId) return;
    setSyncing(true); setMessage('');
    const { data: auth } = await supabase.auth.getSession();
    const res = await fetch('/api/debts/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.session?.access_token || ''}` }, body: JSON.stringify({ session_id: sessionId }) });
    const json = await res.json();
    if (!res.ok) setMessage(json.error || 'Synchronisation impossible.');
    else setMessage(`${json.detected || 0} dette(s) détectée(s), ${json.inserted || 0} nouvelle(s) créée(s).`);
    setSyncing(false); await loadDebts();
  }

  async function setDebtStatus(debt: Debt, next: 'pending' | 'validated') {
    await supabase.from('debts').update({ status: next, validated_at: next === 'validated' ? new Date().toISOString() : null }).eq('id', debt.id);
    await loadDebts();
  }

  async function saveNotes(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (!editing) return;
    const fd = new FormData(e.currentTarget);
    await supabase.from('debts').update({ notes: String(fd.get('notes') || '').trim() || null }).eq('id', editing.id);
    setEditing(null); await loadDebts();
  }

  const pending = debts.filter((d) => d.status === 'pending').length;
  const validated = debts.filter((d) => d.status === 'validated').length;

  if (loading && !sessions.length) return <Loading />;

  return <div className="space-y-6">
    <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-4">
      <div><h1 className="page-title">Dettes</h1><p className="page-subtitle">Une UE encore non validée après rattrapage devient une dette. Son statut reste modifiable manuellement.</p></div>
      <div className="flex flex-wrap items-end gap-3"><SessionSelect sessions={sessions} value={sessionId} onChange={setSessionId} /><label className="block min-w-[160px]"><span className="form-label">Statut</span><select className="form-input" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}><option value="all">Toutes</option><option value="pending">Non validées</option><option value="validated">Validées / ex-dettes</option></select></label><button className="btn-primary" disabled={syncing || !sessionId} onClick={syncDebts}><RefreshCw size={16} className={syncing ? 'animate-spin' : ''} /> Synchroniser</button></div>
    </div>
    {message ? <div className="card p-4 text-sm">{message}</div> : null}
    <div className="grid sm:grid-cols-2 gap-3"><div className="card p-5"><div className="text-2xl font-semibold text-red-600">{pending}</div><div className="text-sm muted mt-1">dette(s) non validée(s) dans la vue</div></div><div className="card p-5"><div className="text-2xl font-semibold text-emerald-600">{validated}</div><div className="text-sm muted mt-1">ex-dette(s) validée(s) dans la vue</div></div></div>
    {loading ? <Loading /> : <section className="card overflow-hidden"><div className="overflow-auto"><table className="min-w-full border-collapse"><thead><tr><th className="table-header">Étudiant</th><th className="table-header">UE</th><th className="table-header">Origine</th><th className="table-header">Statut</th><th className="table-header">Informations</th><th className="table-header text-right">Actions</th></tr></thead><tbody>{debts.map((d) => <tr key={d.id} className="border-t" style={{ borderColor:'var(--border)' }}><td className="table-cell font-medium whitespace-nowrap">{d.students ? displayStudent(d.students.first_name, d.students.last_name) : '—'}</td><td className="table-cell">{d.ues?.name || 'UE supprimée'}</td><td className="table-cell whitespace-nowrap">{d.origin_year_label} · S{d.origin_semester}</td><td className="table-cell"><span className={`status-badge ${d.status === 'validated' ? 'grade-a' : 'grade-d'}`}>{d.status === 'validated' ? 'Validée · ex-dette' : 'Non validée'}</span></td><td className="table-cell max-w-[320px]"><button className="text-left text-sm hover:underline" onClick={() => setEditing(d)}>{d.notes || <span className="muted">Ajouter une note…</span>}</button></td><td className="table-cell"><div className="flex justify-end gap-2">{d.status === 'pending' ? <button className="btn-success" onClick={() => setDebtStatus(d, 'validated')}><CheckCircle2 size={15} /> Valider la dette</button> : <button className="btn-secondary" onClick={() => setDebtStatus(d, 'pending')}><RotateCcw size={15} /> Réouvrir</button>}</div></td></tr>)}{!debts.length ? <tr><td colSpan={6} className="p-10 text-center text-sm muted">Aucune dette dans cette vue.</td></tr> : null}</tbody></table></div></section>}
    <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title="Informations sur la dette">{editing ? <form className="space-y-4" onSubmit={saveNotes}><label className="block"><span className="form-label">Note facultative</span><textarea name="notes" className="form-input min-h-[150px]" defaultValue={editing.notes || ''} placeholder="Ex. épreuve complémentaire prévue en janvier…" /></label><div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setEditing(null)}>Annuler</button><button className="btn-primary">Enregistrer</button></div></form> : null}</Modal>
  </div>;
}
