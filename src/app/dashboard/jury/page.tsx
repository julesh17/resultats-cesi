'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Filter, Pencil, RefreshCw } from 'lucide-react';
import { getSupabaseBrowser } from '@/lib/supabase/client';
import type { CesiSession, Debt, Evaluation, Grade, JuryComputed, JuryOpinion, JuryRecord, Preconisation, Student, UE } from '@/lib/types';
import { computeJury, defaultPreconisations, opinionLabel } from '@/lib/results';
import { cycleYears, displayStudent, yearToSemesters } from '@/lib/utils';
import SessionSelect from '@/components/SessionSelect';
import Loading from '@/components/Loading';
import Modal from '@/components/Modal';
import { OpinionBadge } from '@/components/Badge';

type JuryRow = { student: Student; record: JuryRecord | null; computed: JuryComputed; effective: JuryOpinion | null; hasPreviousJury: boolean; selectedPrecos: number[] };

export default function JuryPage() {
  const supabase = useMemo(() => getSupabaseBrowser(), []);
  const [sessions, setSessions] = useState<CesiSession[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [yearLabel, setYearLabel] = useState('A4');
  const [absenceThreshold, setAbsenceThreshold] = useState(3);
  const [complexOnly, setComplexOnly] = useState(true);
  const [students, setStudents] = useState<Student[]>([]);
  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [ues, setUes] = useState<UE[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [debts, setDebts] = useState<Debt[]>([]);
  const [records, setRecords] = useState<JuryRecord[]>([]);
  const [preconisations, setPreconisations] = useState<Preconisation[]>([]);
  const [links, setLinks] = useState<Array<{ jury_record_id: string; preconisation_id: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<JuryRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadSessions = useCallback(async () => {
    const { data } = await supabase.from('sessions').select('*').order('name');
    const rows = (data || []) as CesiSession[]; setSessions(rows);
    if (!sessionId && rows.length) { setSessionId(rows[0].id); setYearLabel(cycleYears(rows[0].cycle)[0].label); }
  }, [supabase, sessionId]);

  const loadData = useCallback(async () => {
    if (!sessionId) { setLoading(false); return; }
    setLoading(true);
    const session = sessions.find((s) => s.id === sessionId);
    if (session && !cycleYears(session.cycle).some((y) => y.label === yearLabel)) setYearLabel(cycleYears(session.cycle)[0].label);
    const semesters = yearToSemesters(yearLabel);
    const [st, ev, ue, db, jr, pc] = await Promise.all([
      supabase.from('students').select('*').eq('session_id', sessionId).eq('active', true).order('last_name'),
      supabase.from('evaluations').select('*').eq('session_id', sessionId).in('semester', semesters).eq('active', true),
      supabase.from('ues').select('*').eq('session_id', sessionId).in('semester', semesters).eq('active', true),
      supabase.from('debts').select('*'),
      supabase.from('jury_records').select('*'),
      supabase.from('preconisations').select('*').order('id'),
    ]);
    const studentRows = (st.data || []) as Student[]; const evalRows = (ev.data || []) as Evaluation[];
    let gradeRows: Grade[] = [];
    if (studentRows.length && evalRows.length) { const { data } = await supabase.from('grades').select('*').in('student_id', studentRows.map((s) => s.id)).in('evaluation_id', evalRows.map((e) => e.id)); gradeRows = (data || []) as Grade[]; }
    const studentIds = new Set(studentRows.map((s) => s.id));
    const debtRows = ((db.data || []) as Debt[]).filter((d) => studentIds.has(d.student_id));
    const recordRows = ((jr.data || []) as JuryRecord[]).filter((r) => studentIds.has(r.student_id));
    const recordIds = recordRows.map((r) => r.id); let linkRows: Array<{ jury_record_id: string; preconisation_id: number }> = [];
    if (recordIds.length) { const { data } = await supabase.from('jury_preconisations').select('jury_record_id,preconisation_id').in('jury_record_id', recordIds); linkRows = (data || []) as typeof linkRows; }
    setStudents(studentRows); setEvaluations(evalRows); setUes((ue.data || []) as UE[]); setGrades(gradeRows); setDebts(debtRows); setRecords(recordRows); setPreconisations((pc.data || []) as Preconisation[]); setLinks(linkRows); setLoading(false);
  }, [supabase, sessionId, yearLabel, sessions]);

  useEffect(() => { loadSessions(); }, [loadSessions]);
  useEffect(() => { if (sessions.length) loadData(); }, [loadData, sessions.length]);

  const currentSession = sessions.find((s) => s.id === sessionId);
  const rows = useMemo<JuryRow[]>(() => students.map((student) => {
    const record = records.find((r) => r.student_id === student.id && r.year_label === yearLabel) || null;
    const computed = computeJury(student, yearLabel, evaluations, ues, grades, debts, record);
    const yearNumber = Number(yearLabel.slice(1));
    const hasPreviousJury = records.some((r) => r.student_id === student.id && Number(r.year_label.slice(1)) < yearNumber);
    const selectedPrecos = record ? links.filter((l) => l.jury_record_id === record.id).map((l) => l.preconisation_id) : [];
    return { student, record, computed, effective: record?.opinion_override || computed.automaticOpinion, hasPreviousJury, selectedPrecos };
  }), [students, records, yearLabel, evaluations, ues, grades, debts, links]);

  const shownRows = rows.filter((r) => !complexOnly || r.computed.absences >= absenceThreshold || r.computed.totalUeNotValidated > 0 || r.computed.pendingPreviousDebts > 0 || r.computed.validatedPreviousDebts > 0 || r.computed.missingGrades > 0 || r.effective !== 'favorable');

  async function saveJury(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (!editing) return; setSaving(true); setError('');
    const fd = new FormData(e.currentTarget);
    const overrideRaw = String(fd.get('opinion') || 'auto');
    const major = fd.get('major_behavior_issue') === 'on';
    const previousRespected = fd.get('previous_recommendations_respected') === 'on';
    const supplement = String(fd.get('supplementary_info') || '').trim() || null;
    const notes = String(fd.get('jury_notes') || '').trim() || null;
    const selected = preconisations.filter((p) => fd.get(`preco-${p.id}`) === 'on').map((p) => p.id);
    const { data: auth } = await supabase.auth.getUser();
    const payload = { student_id: editing.student.id, year_label: yearLabel, opinion_override: overrideRaw === 'auto' ? null : overrideRaw as JuryOpinion, major_behavior_issue: major, previous_recommendations_respected: previousRespected, supplementary_notes: notes, created_by: auth.user?.id || null };
    const rec = await supabase.from('jury_records').upsert(payload, { onConflict: 'student_id,year_label' }).select('*').single();
    if (rec.error) { setError(rec.error.message); setSaving(false); return; }
    const upd = await supabase.from('students').update({ supplementary_info: supplement }).eq('id', editing.student.id);
    if (upd.error) { setError(upd.error.message); setSaving(false); return; }
    await supabase.from('jury_preconisations').delete().eq('jury_record_id', rec.data.id);
    if (selected.length) {
      const autoComputed = computeJury(editing.student, yearLabel, evaluations, ues, grades, debts, { ...rec.data, major_behavior_issue: major, previous_recommendations_respected: previousRespected });
      const autoIds = new Set(defaultPreconisations(autoComputed, { ...rec.data, major_behavior_issue: major, previous_recommendations_respected: previousRespected }, editing.hasPreviousJury, absenceThreshold));
      const ins = await supabase.from('jury_preconisations').insert(selected.map((id) => ({ jury_record_id: rec.data.id, preconisation_id: id, is_auto: autoIds.has(id) })));
      if (ins.error) { setError(ins.error.message); setSaving(false); return; }
    }
    setSaving(false); setEditing(null); await loadData();
  }

  if (loading && !sessions.length) return <Loading />;

  return <div className="space-y-6">
    <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-4"><div><h1 className="page-title">Jury</h1><p className="page-subtitle">Avis calculé par défaut à partir des résultats de l’année, puis modifiable avant le jury.</p></div><div className="flex flex-wrap items-end gap-3"><SessionSelect sessions={sessions} value={sessionId} onChange={(id) => { setSessionId(id); const s = sessions.find((x) => x.id === id); if (s) setYearLabel(cycleYears(s.cycle)[0].label); }} /><label className="block min-w-[115px]"><span className="form-label">Année</span><select className="form-input" value={yearLabel} onChange={(e) => setYearLabel(e.target.value)}>{currentSession ? cycleYears(currentSession.cycle).map((y) => <option key={y.label} value={y.label}>{y.label}</option>) : null}</select></label><button className="btn-secondary" onClick={() => loadData()}><RefreshCw size={16} /> Actualiser</button></div></div>

    <div className="card p-4 flex flex-wrap items-center gap-4"><label className="inline-flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={complexOnly} onChange={(e) => setComplexOnly(e.target.checked)} className="rounded" /><Filter size={15} /> N’afficher que les cas complexes</label><label className="flex items-center gap-2 text-sm"><span className="muted">Seuil absences :</span><input className="form-input !w-20 !py-1.5" type="number" min={1} value={absenceThreshold} onChange={(e) => setAbsenceThreshold(Math.max(1, Number(e.target.value) || 1))} /></label><span className="text-xs muted">Cas complexe = absences nombreuses, UE non validée, dette ou ex-dette, note manquante, ou avis autre que favorable.</span></div>

    {!ues.length && !loading ? <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">Aucun référentiel trouvé pour {yearLabel}. L’avis automatique reste indéterminé tant que les UE/ECTS ne sont pas disponibles.</div> : null}

    {loading ? <Loading /> : <section className="card overflow-hidden"><div className="overflow-auto"><table className="min-w-full border-collapse"><thead><tr><th className="table-header">Étudiant</th><th className="table-header">S{yearToSemesters(yearLabel)[0]}</th><th className="table-header">S{yearToSemesters(yearLabel)[1]}</th><th className="table-header">ECTS acquis</th><th className="table-header">UE non validées</th><th className="table-header">Abs.</th><th className="table-header">Dettes</th><th className="table-header">Avis</th><th className="table-header">Préconisations</th><th className="table-header"></th></tr></thead><tbody>{shownRows.map((r) => { const defaultIds = r.selectedPrecos.length ? r.selectedPrecos : defaultPreconisations(r.computed, r.record, r.hasPreviousJury, absenceThreshold); return <tr key={r.student.id} className="border-t align-top" style={{ borderColor:'var(--border)' }}><td className="table-cell font-medium whitespace-nowrap"><div>{displayStudent(r.student.first_name, r.student.last_name)}</div>{r.student.supplementary_info ? <div className="text-xs muted mt-1 max-w-[250px] whitespace-normal">{r.student.supplementary_info}</div> : null}</td>{yearToSemesters(yearLabel).map((s) => <td key={s} className="table-cell"><span className={`status-badge ${r.computed.semesterValidated[s] === true ? 'grade-a' : r.computed.semesterValidated[s] === false ? 'grade-d' : 'grade-empty'}`}>{r.computed.semesterValidated[s] === true ? 'Validé' : r.computed.semesterValidated[s] === false ? 'Non validé' : '—'}</span></td>)}<td className="table-cell font-medium">{r.computed.ectsAcquired}</td><td className="table-cell">{r.computed.totalUeNotValidated} <span className="text-xs muted">({r.computed.academicUeNotValidated} acad.)</span></td><td className="table-cell">{r.computed.absences}</td><td className="table-cell"><span className={r.computed.pendingPreviousDebts ? 'text-red-600 font-semibold' : ''}>{r.computed.pendingPreviousDebts}</span> <span className="text-xs muted">+ {r.computed.validatedPreviousDebts} ex</span></td><td className="table-cell"><OpinionBadge opinion={r.effective} /></td><td className="table-cell"><div className="flex flex-wrap gap-1 max-w-[220px]">{defaultIds.map((id) => <span key={id} className="status-badge grade-empty font-semibold">#{id}</span>)}{!defaultIds.length ? <span className="muted">—</span> : null}</div></td><td className="table-cell text-right"><button className="btn-secondary !p-2" onClick={() => setEditing(r)} title="Modifier"><Pencil size={15} /></button></td></tr>; })}{!shownRows.length ? <tr><td colSpan={10} className="p-10 text-center text-sm muted">Aucun étudiant ne correspond au filtre.</td></tr> : null}</tbody></table></div></section>}

    <Modal open={Boolean(editing)} onClose={() => { setEditing(null); setError(''); }} title={editing ? `${displayStudent(editing.student.first_name, editing.student.last_name)} · Jury ${yearLabel}` : 'Jury'} wide>
      {editing ? (() => { const initialIds = editing.selectedPrecos.length ? editing.selectedPrecos : defaultPreconisations(editing.computed, editing.record, editing.hasPreviousJury, absenceThreshold); return <form className="space-y-6" onSubmit={saveJury}>
        <div className="grid md:grid-cols-3 gap-3"><div className="rounded-xl bg-gray-50 p-4"><div className="text-xs uppercase font-semibold muted">Avis automatique</div><div className="mt-2"><OpinionBadge opinion={editing.computed.automaticOpinion} /></div></div><div className="rounded-xl bg-gray-50 p-4"><div className="text-xs uppercase font-semibold muted">ECTS acquis</div><div className="text-xl font-semibold mt-1">{editing.computed.ectsAcquired}</div></div><div className="rounded-xl bg-gray-50 p-4"><div className="text-xs uppercase font-semibold muted">Points à surveiller</div><div className="text-xs mt-1">{editing.computed.reasons.join(' · ') || 'Aucun signal automatique'}</div></div></div>
        <div className="grid md:grid-cols-2 gap-4"><label className="block"><span className="form-label">Avis retenu</span><select name="opinion" className="form-input" defaultValue={editing.record?.opinion_override || 'auto'}><option value="auto">Automatique — {opinionLabel(editing.computed.automaticOpinion)}</option><option value="favorable">Avis favorable</option><option value="reserve">Avis réservé</option><option value="defavorable">Avis défavorable</option></select></label><div className="space-y-3 pt-1"><label className="flex items-start gap-2 text-sm"><input name="major_behavior_issue" type="checkbox" defaultChecked={editing.record?.major_behavior_issue || false} className="mt-1" /><span><strong>Écart de comportement majeur</strong><br/><span className="text-xs muted">Force l’avis automatique défavorable.</span></span></label><label className="flex items-start gap-2 text-sm"><input name="previous_recommendations_respected" type="checkbox" defaultChecked={editing.record?.previous_recommendations_respected ?? true} className="mt-1" /><span><strong>Préconisations du jury précédent respectées</strong><br/><span className="text-xs muted">Décochez si elles n’ont pas été respectées.</span></span></label></div></div>
        <div className="grid lg:grid-cols-2 gap-4"><label className="block"><span className="form-label">Infos complémentaires étudiant · facultatif</span><textarea name="supplementary_info" className="form-input min-h-[120px]" defaultValue={editing.student.supplementary_info || ''} placeholder="Information utile, contexte particulier…" /></label><label className="block"><span className="form-label">Notes internes du jury · facultatif</span><textarea name="jury_notes" className="form-input min-h-[120px]" defaultValue={editing.record?.supplementary_notes || ''} placeholder="Commentaires propres à ce jury…" /></label></div>
        <div><div className="flex items-center justify-between gap-4 mb-3"><div><h3 className="font-semibold">Préconisations</h3><p className="text-xs muted mt-1">Les suggestions par défaut sont cochées. Vous pouvez tout modifier. Le numéro reste toujours visible.</p></div></div><div className="grid md:grid-cols-2 gap-2">{preconisations.map((p) => <label key={p.id} className={`rounded-xl border p-3 flex items-start gap-3 cursor-pointer ${initialIds.includes(p.id) ? 'bg-blue-50 border-blue-200' : 'bg-white'}`}><input name={`preco-${p.id}`} type="checkbox" defaultChecked={initialIds.includes(p.id)} className="mt-1" /><span className="status-badge grade-b shrink-0 font-bold">#{p.id}</span><span className="text-sm"><strong className="text-xs uppercase tracking-wide">{p.category}</strong><br/>{p.text}</span></label>)}</div></div>
        {error ? <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div> : null}<div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setEditing(null)}>Annuler</button><button className="btn-primary" disabled={saving}>{saving ? 'Enregistrement…' : 'Enregistrer le jury'}</button></div>
      </form>; })() : null}
    </Modal>
  </div>;
}
