'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, Download, RefreshCw } from 'lucide-react';
import * as XLSX from 'xlsx';
import { getSupabaseBrowser } from '@/lib/supabase/client';
import type { CesiSession, Evaluation, Grade, Student, UE } from '@/lib/types';
import { buildParallelGroups, buildRetakeMap } from '@/lib/results';
import { cycleYears, displayStudent } from '@/lib/utils';
import SessionSelect from '@/components/SessionSelect';
import Loading from '@/components/Loading';

function makeIndividualMail(student: Student, evaluations: Evaluation[]) {
  const list = evaluations.map((e) => `  • ${e.name}`).join('\n');
  return `Bonjour ${student.first_name} ${student.last_name},\n\nNous vous informons que vous êtes concerné(e) par des rattrapages dans les matières suivantes :\n\n${list}\n\nNous vous invitons donc à vous présenter aux sessions de rattrapage dont les modalités vous seront communiquées prochainement.\n\nN'hésitez pas à nous contacter si vous avez des questions.\n\nBien cordialement,\nL'équipe pédagogique`;
}

export default function RattrapagesPage() {
  const supabase = useMemo(() => getSupabaseBrowser(), []);
  const [sessions, setSessions] = useState<CesiSession[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [semester, setSemester] = useState(7);
  const [students, setStudents] = useState<Student[]>([]);
  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [ues, setUes] = useState<UE[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'synthese' | 'organisation' | 'mails'>('synthese');
  const [copied, setCopied] = useState('');
  const [mailEdits, setMailEdits] = useState<Record<string, string>>({});

  const loadSessions = useCallback(async () => {
    const { data } = await supabase.from('sessions').select('*').order('name');
    const list = (data || []) as CesiSession[];
    setSessions(list);
    if (!sessionId && list.length) {
      setSessionId(list[0].id);
      setSemester(cycleYears(list[0].cycle)[0].semesters[0]);
    }
  }, [supabase, sessionId]);

  const loadData = useCallback(async () => {
    if (!sessionId) { setLoading(false); return; }
    setLoading(true);
    const [s, e, u] = await Promise.all([
      supabase.from('students').select('*').eq('session_id', sessionId).eq('active', true).order('last_name'),
      supabase.from('evaluations').select('*').eq('session_id', sessionId).eq('semester', semester).eq('active', true).order('name'),
      supabase.from('ues').select('*').eq('session_id', sessionId).eq('semester', semester).eq('active', true).order('name'),
    ]);
    const studentRows = (s.data || []) as Student[];
    const evalRows = (e.data || []) as Evaluation[];
    let gradeRows: Grade[] = [];
    if (studentRows.length && evalRows.length) {
      const { data } = await supabase.from('grades').select('*').in('student_id', studentRows.map((x) => x.id)).in('evaluation_id', evalRows.map((x) => x.id));
      gradeRows = (data || []) as Grade[];
    }
    setStudents(studentRows);
    setEvaluations(evalRows);
    setUes((u.data || []) as UE[]);
    setGrades(gradeRows);
    setLoading(false);
  }, [supabase, sessionId, semester]);

  useEffect(() => { loadSessions(); }, [loadSessions]);
  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => { setMailEdits({}); }, [sessionId, semester]);

  const currentSession = sessions.find((s) => s.id === sessionId);
  const retakes = useMemo(() => buildRetakeMap(students, evaluations, grades, ues), [students, evaluations, grades, ues]);
  const org = useMemo(() => buildParallelGroups(evaluations, retakes.current), [evaluations, retakes.current]);
  const currentCount = [...retakes.current.values()].reduce((s, x) => s + x.length, 0);
  const failedCount = [...retakes.failedAfterResit.values()].reduce((s, x) => s + x.length, 0);
  const byStudent = useMemo(() => {
    const map = new Map<string, Evaluation[]>();
    for (const evaluation of evaluations) {
      for (const student of retakes.current.get(evaluation.id) || []) {
        const list = map.get(student.id) || [];
        list.push(evaluation);
        map.set(student.id, list);
      }
    }
    return map;
  }, [evaluations, retakes.current]);

  const classMail = useMemo(() => {
    const lines = ['Bonjour à tous,', '', 'Voici le récapitulatif des convocations aux rattrapages par matière :', ''];
    for (const evaluation of evaluations) {
      const list = retakes.current.get(evaluation.id) || [];
      if (list.length) lines.push(`• ${evaluation.name} : ${list.map((s) => displayStudent(s.first_name, s.last_name)).join(', ')}`);
    }
    lines.push('', 'Les étudiants concernés sont invités à se présenter aux sessions de rattrapage dont les modalités leur seront communiquées prochainement.', '', 'Bien cordialement,', "L'équipe pédagogique");
    return lines.join('\n');
  }, [evaluations, retakes.current]);

  async function copy(text: string, key: string) {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(''), 1400);
  }

  function exportExcel() {
    const wb = XLSX.utils.book_new();
    const synthese = evaluations.flatMap((e) => {
      const rows: Record<string, unknown>[] = [];
      for (const s of retakes.current.get(e.id) || []) rows.push({ Matière: e.name, Statut: 'Rattrapage à organiser', Prénom: s.first_name, Nom: s.last_name });
      for (const s of retakes.failedAfterResit.get(e.id) || []) rows.push({ Matière: e.name, Statut: 'Échec après rattrapage / dette potentielle', Prénom: s.first_name, Nom: s.last_name });
      return rows;
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(synthese.length ? synthese : [{ Information: 'Aucun rattrapage' }]), 'Synthèse');
    const slots = org.groups.flatMap((group, i) => group.map((e) => ({ Créneau: `Créneau ${i + 1}`, Matière: e.name, Étudiants: (retakes.current.get(e.id) || []).map((s) => displayStudent(s.first_name, s.last_name)).join(', ') })));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(slots.length ? slots : [{ Information: 'Aucun créneau' }]), 'Créneaux');
    XLSX.writeFile(wb, `rattrapages_${currentSession?.analytic_code || 'session'}_S${semester}.xlsx`);
  }

  if (loading && !sessions.length) return <Loading />;

  return (
    <div className="space-y-6">
      <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-4">
        <div><h1 className="page-title">Rattrapages</h1><p className="page-subtitle">Synthèse des convocations, organisation de matières en parallèle et repérage des échecs après rattrapage.</p></div>
        <div className="flex flex-wrap items-end gap-3">
          <SessionSelect sessions={sessions} value={sessionId} onChange={(id) => { setSessionId(id); const s = sessions.find((x) => x.id === id); if (s) setSemester(cycleYears(s.cycle)[0].semesters[0]); }} />
          <label className="block min-w-[130px]"><span className="form-label">Semestre</span><select className="form-select" value={semester} onChange={(e) => setSemester(Number(e.target.value))}>{currentSession ? cycleYears(currentSession.cycle).flatMap((y) => y.semesters).map((n) => <option key={n} value={n}>S{n}</option>) : null}</select></label>
          <button className="btn-secondary" onClick={() => loadData()}><RefreshCw size={16} /> Actualiser</button>
          <button className="btn-primary" onClick={exportExcel} disabled={!evaluations.length}><Download size={16} /> Export Excel</button>
        </div>
      </div>

      <div className="grid sm:grid-cols-3 gap-3">
        <div className="card p-5"><div className="text-2xl font-semibold">{currentCount}</div><div className="text-sm muted mt-1">situations de rattrapage à organiser</div></div>
        <div className="card p-5"><div className="text-2xl font-semibold">{org.groups.length}</div><div className="text-sm muted mt-1">créneau(x) proposés en parallèle</div></div>
        <div className="card p-5"><div className="text-2xl font-semibold text-red-600">{failedCount}</div><div className="text-sm muted mt-1">échec(s) après rattrapage · dette potentielle</div></div>
      </div>

      <div className="flex bg-white border rounded-xl p-1 w-fit" style={{ borderColor: 'var(--border)' }}>
        {([['synthese','Synthèse'], ['organisation','Organisation'], ['mails','Mails']] as const).map(([id, label]) => <button key={id} onClick={() => setTab(id)} className={`px-4 py-2 rounded-lg text-sm font-medium ${tab === id ? 'bg-gray-100' : 'muted'}`}>{label}</button>)}
      </div>

      {loading ? <Loading /> : tab === 'synthese' ? (
        <div className="grid xl:grid-cols-2 gap-4">
          <section className="card overflow-hidden">
            <div className="p-5 border-b" style={{ borderColor: 'var(--border)' }}><h2 className="section-title">À organiser</h2><p className="text-sm muted mt-1">C, D, AJ ou ANJ non compensés, sans rattrapage déjà visible dans la cellule.</p></div>
            <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {evaluations.filter((e) => (retakes.current.get(e.id)?.length || 0) > 0).map((e) => <div key={e.id} className="p-4"><div className="flex justify-between gap-3"><div className="font-medium text-sm">{e.name}</div><span className="status-badge grade-c">{retakes.current.get(e.id)?.length || 0}</span></div><div className="flex flex-wrap gap-1.5 mt-3">{(retakes.current.get(e.id) || []).map((s) => <span key={s.id} className="status-badge grade-empty">{displayStudent(s.first_name, s.last_name)}</span>)}</div></div>)}
              {!currentCount ? <div className="p-8 text-center text-sm muted">Aucun rattrapage à organiser pour ce semestre.</div> : null}
            </div>
          </section>
          <section className="card overflow-hidden">
            <div className="p-5 border-b" style={{ borderColor: 'var(--border)' }}><h2 className="section-title">Échecs après rattrapage</h2><p className="text-sm muted mt-1">La cellule contient un slash (ex. C/C ou C/D) et la lettre finale ne valide toujours pas l’évaluation.</p></div>
            <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {evaluations.filter((e) => (retakes.failedAfterResit.get(e.id)?.length || 0) > 0).map((e) => <div key={e.id} className="p-4"><div className="flex justify-between gap-3"><div className="font-medium text-sm">{e.name}</div><span className="status-badge grade-d">{retakes.failedAfterResit.get(e.id)?.length || 0}</span></div><div className="flex flex-wrap gap-1.5 mt-3">{(retakes.failedAfterResit.get(e.id) || []).map((s) => <span key={s.id} className="status-badge grade-d">{displayStudent(s.first_name, s.last_name)}</span>)}</div></div>)}
              {!failedCount ? <div className="p-8 text-center text-sm muted">Aucun échec après rattrapage détecté.</div> : null}
            </div>
          </section>
        </div>
      ) : tab === 'organisation' ? (
        <div className="space-y-4">
          <div className="card p-5 text-sm muted">Deux matières peuvent être placées dans le même créneau lorsqu’aucun étudiant convoqué n’est commun. La proposition est calculée automatiquement par regroupement glouton : elle est pratique, mais n’est pas une preuve mathématique du nombre minimal de créneaux.</div>
          <div className="grid lg:grid-cols-2 gap-4">
            {org.groups.map((group, i) => <section className="card p-5" key={i}><div className="flex items-center justify-between gap-3 mb-4"><h3 className="font-semibold">Créneau {i + 1}</h3><span className="status-badge grade-b">{group.length} matière(s)</span></div><div className="space-y-3">{group.map((e) => <div key={e.id} className="rounded-xl bg-gray-50 p-3"><div className="font-medium text-sm">{e.name}</div><div className="text-xs muted mt-1">{(retakes.current.get(e.id) || []).map((s) => displayStudent(s.first_name, s.last_name)).join(', ')}</div></div>)}</div></section>)}
          </div>
          {org.groups.length > 0 ? <section className="card overflow-hidden"><div className="p-5 border-b" style={{ borderColor:'var(--border)' }}><h3 className="section-title">Matrice de compatibilité</h3><p className="text-xs muted mt-1">✓ = aucun étudiant commun · nombre = conflits.</p></div><div className="overflow-auto"><table className="border-collapse min-w-full"><thead><tr><th className="table-header">Matière</th>{evaluations.filter((e) => (retakes.current.get(e.id)?.length || 0) > 0).map((e) => <th key={e.id} className="table-header text-center min-w-[95px]" title={e.name}>{e.name.slice(0, 18)}{e.name.length > 18 ? '…' : ''}</th>)}</tr></thead><tbody>{evaluations.filter((e) => (retakes.current.get(e.id)?.length || 0) > 0).map((a) => <tr key={a.id} className="border-t" style={{ borderColor:'var(--border)' }}><td className="table-cell font-medium whitespace-nowrap">{a.name}</td>{evaluations.filter((e) => (retakes.current.get(e.id)?.length || 0) > 0).map((b) => { if (a.id === b.id) return <td key={b.id} className="table-cell text-center bg-gray-100">—</td>; const sa = new Set((retakes.current.get(a.id) || []).map((s) => s.id)); const conflict = (retakes.current.get(b.id) || []).filter((s) => sa.has(s.id)).length; return <td key={b.id} className={`table-cell text-center font-semibold ${conflict ? 'text-red-600 bg-red-50' : 'text-emerald-700 bg-emerald-50'}`}>{conflict || '✓'}</td>; })}</tr>)}</tbody></table></div></section> : null}
          {!org.groups.length ? <div className="card p-8 text-center text-sm muted">Aucun créneau à organiser.</div> : null}
        </div>
      ) : (
        <div className="space-y-4">
          {byStudent.size ? <section className="card p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">Mail récapitulatif à la classe</h3><p className="text-xs muted mt-1">Un récapitulatif par matière, modifiable avant copie.</p></div><button className="btn-secondary" onClick={() => copy(mailEdits.__class__ ?? classMail, '__class__')}><Copy size={15} /> {copied === '__class__' ? 'Copié !' : 'Copier le récap'}</button></div><textarea className="form-input mt-4 min-h-[240px]" value={mailEdits.__class__ ?? classMail} onChange={(e) => setMailEdits((prev) => ({ ...prev, __class__: e.target.value }))} /></section> : null}
          {[...byStudent.entries()].map(([studentId, evals]) => { const student = students.find((s) => s.id === studentId)!; const generated = makeIndividualMail(student, evals); const text = mailEdits[studentId] ?? generated; return <section key={studentId} className="card p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">{displayStudent(student.first_name, student.last_name)}</h3><p className="text-xs muted mt-1">{evals.map((e) => e.name).join(' · ')}</p></div><button className="btn-secondary" onClick={() => copy(text, studentId)}><Copy size={15} /> {copied === studentId ? 'Copié !' : 'Copier le mail'}</button></div><textarea className="form-input mt-4 min-h-[220px]" value={text} onChange={(e) => setMailEdits((prev) => ({ ...prev, [studentId]: e.target.value }))} /></section>; })}
          {!byStudent.size ? <div className="card p-8 text-center text-sm muted">Aucun mail à générer.</div> : null}
        </div>
      )}
    </div>
  );
}
