'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { Download, Pencil, RefreshCw, Search, Trash2 } from 'lucide-react';
import Loading from '@/components/Loading';
import Modal from '@/components/Modal';
import SessionSelect from '@/components/SessionSelect';
import { GradeBadge } from '@/components/Badge';
import { getSupabaseBrowser } from '@/lib/supabase/client';
import { fetchAllRows } from '@/lib/supabase/fetchAll';
import type { CesiSession, Evaluation, Grade, Student, UE } from '@/lib/types';
import {
  computeStudentUE,
  computeStudentUEs,
  makeGradeMap,
  makeInferredBlankAbsenceSet,
  parseMention,
} from '@/lib/results';
import { cycleYears, displayStudent, normalizeText } from '@/lib/utils';

export default function NotesPage() {
  const [loading, setLoading] = useState(true);
  const [sessions, setSessions] = useState<CesiSession[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [semester, setSemester] = useState(7);
  const [students, setStudents] = useState<Student[]>([]);
  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [ues, setUes] = useState<UE[]>([]);
  const [view, setView] = useState<'notes' | 'ue' | 'synthese'>('notes');
  const [summaryMode, setSummaryMode] = useState<'ue' | 'evaluation'>('ue');
  const [search, setSearch] = useState('');
  const [summarySearch, setSummarySearch] = useState('');
  const [selected, setSelected] = useState<{ student: Student; evaluation: Evaluation; grade: Grade | null } | null>(null);
  const [selectedStudent, setSelectedStudent] = useState<Student | null>(null);
  const [error, setError] = useState('');

  async function loadSessions() {
    const { data } = await getSupabaseBrowser().from('sessions').select('*').order('name');
    const rows = (data || []) as CesiSession[];
    setSessions(rows);
    if (!sessionId && rows.length) {
      setSessionId(rows[0].id);
      const years = cycleYears(rows[0].cycle);
      setSemester(years[0].semesters[0]);
    }
    setLoading(false);
  }

  async function loadData(id = sessionId, sem = semester) {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const supabase = getSupabaseBrowser();
      const [st, ev, ue] = await Promise.all([
        supabase.from('students').select('*').eq('session_id', id).eq('active', true).order('last_name'),
        supabase.from('evaluations').select('*').eq('session_id', id).eq('semester', sem).eq('active', true).order('name'),
        supabase.from('ues').select('*').eq('session_id', id).eq('semester', sem).eq('active', true).order('name'),
      ]);
      if (st.error) throw new Error(st.error.message);
      if (ev.error) throw new Error(ev.error.message);
      if (ue.error) throw new Error(ue.error.message);

      const studentRows = (st.data || []) as Student[];
      const evalRows = (ev.data || []) as Evaluation[];
      const ids = evalRows.map((x) => x.id);
      let gradeRows: Grade[] = [];
      if (ids.length) {
        gradeRows = await fetchAllRows<Grade>((from, to) =>
          supabase
            .from('grades')
            .select('*')
            .in('evaluation_id', ids)
            .order('id')
            .range(from, to),
        );
      }
      setStudents(studentRows);
      setEvaluations(evalRows);
      setUes((ue.data || []) as UE[]);
      setGrades(gradeRows);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lecture impossible.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadSessions(); }, []);
  useEffect(() => { if (sessionId) loadData(); }, [sessionId, semester]);

  const currentSession = sessions.find((s) => s.id === sessionId);
  const gradeMap = useMemo(() => makeGradeMap(grades), [grades]);
  const inferredBlankAbsences = useMemo(
    () => makeInferredBlankAbsenceSet(students, evaluations, grades),
    [students, evaluations, grades],
  );
  const filteredStudents = useMemo(
    () => students.filter((s) => displayStudent(s.first_name, s.last_name).toLowerCase().includes(search.toLowerCase())),
    [search, students],
  );

  const ueSummary = useMemo(() => {
    const term = normalizeText(summarySearch);
    return ues
      .filter((ue) => !term || normalizeText(ue.name).includes(term))
      .map((ue) => {
        const passed: Student[] = [];
        const failed: Student[] = [];
        const pending: Student[] = [];
        for (const student of filteredStudents) {
          const result = computeStudentUE(student.id, ue, evaluations, gradeMap, inferredBlankAbsences);
          if (result.missing) pending.push(student);
          else if (result.validated) passed.push(student);
          else failed.push(student);
        }
        return { ue, passed, failed, pending };
      });
  }, [ues, summarySearch, filteredStudents, evaluations, gradeMap, inferredBlankAbsences]);

  const evaluationSummary = useMemo(() => {
    const term = normalizeText(summarySearch);
    return evaluations
      .filter((evaluation) => !term || normalizeText(evaluation.name).includes(term))
      .map((evaluation) => {
        const passed: Student[] = [];
        const failed: Student[] = [];
        const pending: Student[] = [];
        for (const student of filteredStudents) {
          const key = `${student.id}:${evaluation.id}`;
          const grade = gradeMap.get(key);
          const inferred = inferredBlankAbsences.has(key);
          if (grade?.final_mention === 'A' || grade?.final_mention === 'B') passed.push(student);
          else if (
            grade?.final_mention === 'C'
            || grade?.final_mention === 'D'
            || grade?.absence === 'AJ'
            || grade?.absence === 'ANJ'
            || inferred
          ) failed.push(student);
          else pending.push(student);
        }
        return { evaluation, passed, failed, pending };
      });
  }, [evaluations, summarySearch, filteredStudents, gradeMap, inferredBlankAbsences]);

  async function saveGrade(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setError('');
    const form = new FormData(event.currentTarget);
    const raw = String(form.get('mention') || '').trim().toUpperCase();
    const numeric = String(form.get('numeric') || '').trim();
    const absenceValue = String(form.get('absence') || '');
    const parsed = parseMention(raw);
    const absence = absenceValue === 'AJ' || absenceValue === 'ANJ' ? absenceValue : parsed.absence;
    const supabase = getSupabaseBrowser();
    const { data: auth } = await supabase.auth.getUser();
    const payload = {
      student_id: selected.student.id,
      evaluation_id: selected.evaluation.id,
      raw_mention: absence ? null : parsed.raw,
      initial_mention: absence ? null : parsed.initial,
      final_mention: absence ? null : parsed.final,
      numeric_note_text: numeric || null,
      absence,
      manual_override: true,
      updated_by: auth.user?.id || null,
    };
    const { error: upsertError } = await supabase.from('grades').upsert(payload, { onConflict: 'student_id,evaluation_id' });
    if (upsertError) { setError(upsertError.message); return; }

    const { data: session } = await supabase.auth.getSession();
    if (session.session) {
      await fetch('/api/debts/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${session.session.access_token}` },
        body: JSON.stringify({ session_id: sessionId }),
      });
    }
    setSelected(null);
    await loadData();
  }

  async function saveStudent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedStudent) return;
    const form = new FormData(event.currentTarget);
    const { error: updateError } = await getSupabaseBrowser().from('students').update({
      first_name: String(form.get('first_name') || '').trim(),
      last_name: String(form.get('last_name') || '').trim(),
      option_name: String(form.get('option_name') || '').trim() || null,
      supplementary_info: String(form.get('supplementary_info') || '').trim() || null,
    }).eq('id', selectedStudent.id);
    if (updateError) { setError(updateError.message); return; }
    setSelectedStudent(null);
    await loadData();
  }

  async function deleteStudent() {
    if (!selectedStudent) return;
    const fullName = displayStudent(selectedStudent.first_name, selectedStudent.last_name);
    if (!window.confirm(`Supprimer ${fullName} de cette session ?`)) return;
    setError('');
    // Retrait logique : l'étudiant disparaît de l'application mais son historique reste
    // intact. Les réimports ultérieurs du même fichier ne le réactivent pas.
    const { error: deleteError } = await getSupabaseBrowser()
      .from('students')
      .update({ active: false })
      .eq('id', selectedStudent.id);
    if (deleteError) { setError(deleteError.message); return; }
    setSelectedStudent(null);
    await loadData();
  }

  function exportView() {
    const rows = filteredStudents.map((student) => {
      const row: Record<string, string> = { Prénom: student.first_name, Nom: student.last_name };
      for (const evaluation of evaluations) {
        const g = gradeMap.get(`${student.id}:${evaluation.id}`);
        row[evaluation.name] = g?.final_mention || g?.absence || '';
        row[`${evaluation.name} — note numérique`] = g?.numeric_note_text || '';
      }
      return row;
    });
    const exportWb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(exportWb, XLSX.utils.json_to_sheet(rows), `S${semester} Notes`);
    const ueRows = filteredStudents.flatMap((student) => computeStudentUEs(student.id, ues, evaluations, gradeMap, inferredBlankAbsences).map((r) => ({
      Prénom: student.first_name,
      Nom: student.last_name,
      UE: r.ue.name,
      Mention: r.mention || '',
      'Moyenne pondérée': r.weightedAverage ?? '',
      Statut: r.missing ? 'En cours' : r.validated ? (r.compensation ? 'Validée par compensation' : 'Validée') : 'Non validée',
    })));
    if (ueRows.length) XLSX.utils.book_append_sheet(exportWb, XLSX.utils.json_to_sheet(ueRows), `S${semester} UE`);
    XLSX.writeFile(exportWb, `resultats_${currentSession?.analytic_code || 'session'}_S${semester}.xlsx`);
  }

  if (loading && !sessions.length) return <Loading />;

  return (
    <div className="space-y-6">
      <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-4">
        <div>
          <h1 className="page-title">Notes & UE</h1>
          <p className="page-subtitle">Consultez et modifiez les résultats par semestre et par UE.</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <SessionSelect sessions={sessions} value={sessionId} onChange={(id) => {
            setSessionId(id);
            const s = sessions.find((x) => x.id === id);
            if (s) setSemester(cycleYears(s.cycle)[0].semesters[0]);
          }} />
          <label className="block min-w-[140px]"><span className="form-label">Semestre</span><select className="form-select" value={semester} onChange={(e) => setSemester(Number(e.target.value))}>{currentSession ? cycleYears(currentSession.cycle).flatMap((y) => y.semesters).map((s) => <option key={s} value={s}>S{s}</option>) : null}</select></label>
          <button className="btn-secondary" onClick={() => loadData()}><RefreshCw size={16} /> Actualiser</button>
          <button className="btn-primary" onClick={exportView} disabled={!students.length}><Download size={16} /> Export Excel</button>
        </div>
      </div>

      {error ? <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div> : null}

      <div className="flex flex-col lg:flex-row gap-3 lg:items-center justify-between">
        <div className="flex bg-white border rounded-xl p-1 w-fit flex-wrap" style={{ borderColor: 'var(--border)' }}>
          <button className={`px-4 py-2 rounded-lg text-sm font-medium ${view === 'notes' ? 'bg-gray-100' : 'muted'}`} onClick={() => setView('notes')}>Tableau des notes</button>
          <button className={`px-4 py-2 rounded-lg text-sm font-medium ${view === 'ue' ? 'bg-gray-100' : 'muted'}`} onClick={() => setView('ue')}>Résultats par étudiant</button>
          <button className={`px-4 py-2 rounded-lg text-sm font-medium ${view === 'synthese' ? 'bg-gray-100' : 'muted'}`} onClick={() => setView('synthese')}>Résultats par UE / matière</button>
        </div>
        <label className="relative min-w-[260px]"><Search size={16} className="absolute left-3 top-3 text-gray-400" /><input className="form-input !pl-9" placeholder="Rechercher un étudiant…" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
      </div>

      {loading ? <Loading /> : view === 'notes' ? (
        <section className="card overflow-hidden">
          <div className="overflow-auto max-h-[72vh] scrollbar-thin">
            <table className="border-collapse min-w-full">
              <thead className="sticky top-0 z-20 bg-white">
                <tr>
                  <th className="table-header sticky left-0 z-30 bg-white min-w-[210px] border-r" style={{ borderColor: 'var(--border)' }}>Étudiant</th>
                  {evaluations.map((evaluation) => <th key={evaluation.id} className="table-header min-w-[150px] max-w-[190px] text-center"><span title={evaluation.name} className="line-clamp-3 normal-case tracking-normal font-medium text-gray-700">{evaluation.name}</span></th>)}
                </tr>
              </thead>
              <tbody>
                {filteredStudents.map((student) => (
                  <tr key={student.id} className="border-t hover:bg-gray-50/60" style={{ borderColor: 'var(--border)' }}>
                    <td className="table-cell sticky left-0 bg-white z-10 border-r font-medium whitespace-nowrap" style={{ borderColor: 'var(--border)' }}>
                      <button className="group text-left" onClick={() => setSelectedStudent(student)} title="Modifier les informations de l’étudiant">
                        <span className="inline-flex items-center gap-1">{displayStudent(student.first_name, student.last_name)}<Pencil size={11} className="opacity-0 group-hover:opacity-60" /></span>
                        {student.option_name ? <span className="block text-[11px] muted font-normal mt-0.5">{student.option_name}</span> : null}
                      </button>
                    </td>
                    {evaluations.map((evaluation) => {
                      const grade = gradeMap.get(`${student.id}:${evaluation.id}`) || null;
                      return <td key={evaluation.id} className="table-cell text-center"><button className="group inline-flex items-center gap-1.5" onClick={() => setSelected({ student, evaluation, grade })}><GradeBadge grade={grade} compact /><Pencil size={11} className="opacity-0 group-hover:opacity-60 transition-opacity" /></button></td>;
                    })}
                  </tr>
                ))}
                {!filteredStudents.length ? <tr><td colSpan={evaluations.length + 1} className="p-10 text-center text-sm muted">Aucun étudiant.</td></tr> : null}
              </tbody>
            </table>
          </div>
          {!evaluations.length ? <div className="p-8 text-sm muted text-center">Aucune évaluation active pour S{semester}. Importez le fichier de notes.</div> : null}
        </section>
      ) : view === 'ue' ? (
        <div className="space-y-4">
          {!ues.length ? <div className="card p-6 text-sm muted">Aucun référentiel rattaché à S{semester}. Importez le cahier des charges dans l’onglet Imports.</div> : null}
          {filteredStudents.map((student) => {
            const results = computeStudentUEs(student.id, ues, evaluations, gradeMap, inferredBlankAbsences);
            const notValidated = results.filter((r) => !r.validated && !r.missing).length;
            return (
              <section className="card p-5" key={student.id}>
                <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                  <div><h3 className="font-semibold">{displayStudent(student.first_name, student.last_name)}</h3><p className="text-xs muted mt-0.5">{notValidated} UE non validée(s)</p></div>
                  <button type="button" className="btn-secondary !px-3 !py-1.5" onClick={() => setSelectedStudent(student)}><Pencil size={14} /> Modifier l’étudiant</button>
                </div>
                <div className="grid lg:grid-cols-2 2xl:grid-cols-3 gap-3">
                  {results.map((r) => (
                    <div key={r.ue.id} className={`rounded-xl border p-4 ${r.missing ? 'bg-gray-50 border-gray-200' : r.validated ? (r.compensation ? 'bg-indigo-50 border-indigo-200' : 'bg-emerald-50 border-emerald-200') : 'bg-red-50 border-red-200'}`}>
                      <div className="flex items-start gap-3 justify-between">
                        <div className="min-w-0"><div className="font-medium text-sm">{r.ue.name}</div><div className="text-xs muted mt-1">{r.ue.ects ?? '—'} ECTS · {r.ue.is_enterprise ? 'Entreprise' : 'Académique'}</div></div>
                        <span className={`status-badge ${r.mention === 'A' ? 'grade-a' : r.mention === 'B' ? 'grade-b' : r.mention === 'C' ? 'grade-c' : r.mention === 'D' ? 'grade-d' : 'grade-empty'}`}>{r.mention || '—'}</span>
                      </div>
                      <div className="mt-3 text-xs font-medium">{r.missing ? 'En cours' : r.validated ? (r.compensation ? 'Validée par compensation' : 'Validée') : 'Non validée'} {r.weightedAverage !== null ? `· moyenne ${r.weightedAverage.toFixed(1)}` : ''}</div>
                      <div className="mt-3 border-t pt-2 space-y-1" style={{ borderColor: 'rgba(0,0,0,.08)' }}>
                        {r.elements.map((el) => <div key={el.evaluation.id} className="flex items-center justify-between gap-3 text-xs"><span className="truncate" title={el.evaluation.name}>{el.evaluation.name}</span><div className="flex items-center gap-2 shrink-0"><span className="muted">coef {el.evaluation.coefficient}</span><GradeBadge grade={el.grade} compact /></div></div>)}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="card p-4 flex flex-col md:flex-row gap-3 md:items-center justify-between">
            <div className="flex bg-gray-50 rounded-xl p-1 w-fit">
              <button className={`px-4 py-2 rounded-lg text-sm font-medium ${summaryMode === 'ue' ? 'bg-white shadow-sm' : 'muted'}`} onClick={() => setSummaryMode('ue')}>Par UE</button>
              <button className={`px-4 py-2 rounded-lg text-sm font-medium ${summaryMode === 'evaluation' ? 'bg-white shadow-sm' : 'muted'}`} onClick={() => setSummaryMode('evaluation')}>Par matière</button>
            </div>
            <label className="relative min-w-[280px]"><Search size={16} className="absolute left-3 top-3 text-gray-400" /><input className="form-input !pl-9" placeholder={summaryMode === 'ue' ? 'Rechercher une UE…' : 'Rechercher une matière…'} value={summarySearch} onChange={(e) => setSummarySearch(e.target.value)} /></label>
          </div>

          {summaryMode === 'ue' ? ueSummary.map(({ ue, passed, failed, pending }) => (
            <section className="card p-5" key={ue.id}>
              <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
                <div><h3 className="font-semibold">{ue.name}</h3><p className="text-xs muted mt-1">S{ue.semester} · {ue.ects ?? '—'} ECTS</p></div>
                <div className="flex gap-2"><span className="status-badge grade-a">{passed.length} validée(s)</span><span className="status-badge grade-d">{failed.length} non validée(s)</span>{pending.length ? <span className="status-badge grade-empty">{pending.length} en cours</span> : null}</div>
              </div>
              <div className="grid lg:grid-cols-3 gap-3">
                <div className="rounded-xl bg-emerald-50 border border-emerald-100 p-3"><div className="text-xs font-semibold text-emerald-800 mb-2">UE VALIDÉE</div><div className="flex flex-wrap gap-1.5">{passed.map((s) => <span key={s.id} className="status-badge grade-a">{displayStudent(s.first_name, s.last_name)}</span>)}{!passed.length ? <span className="text-xs muted">Aucun</span> : null}</div></div>
                <div className="rounded-xl bg-red-50 border border-red-100 p-3"><div className="text-xs font-semibold text-red-800 mb-2">UE NON VALIDÉE</div><div className="flex flex-wrap gap-1.5">{failed.map((s) => <span key={s.id} className="status-badge grade-d">{displayStudent(s.first_name, s.last_name)}</span>)}{!failed.length ? <span className="text-xs muted">Aucun</span> : null}</div></div>
                <div className="rounded-xl bg-gray-50 border border-gray-200 p-3"><div className="text-xs font-semibold text-gray-600 mb-2">EN COURS</div><div className="flex flex-wrap gap-1.5">{pending.map((s) => <span key={s.id} className="status-badge grade-empty">{displayStudent(s.first_name, s.last_name)}</span>)}{!pending.length ? <span className="text-xs muted">Aucun</span> : null}</div></div>
              </div>
            </section>
          )) : evaluationSummary.map(({ evaluation, passed, failed, pending }) => (
            <section className="card p-5" key={evaluation.id}>
              <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
                <div><h3 className="font-semibold">{evaluation.name}</h3><p className="text-xs muted mt-1">S{evaluation.semester}</p></div>
                <div className="flex gap-2"><span className="status-badge grade-a">{passed.length} réussi(s)</span><span className="status-badge grade-d">{failed.length} non réussi(s)</span>{pending.length ? <span className="status-badge grade-empty">{pending.length} en cours</span> : null}</div>
              </div>
              <div className="grid lg:grid-cols-3 gap-3">
                <div className="rounded-xl bg-emerald-50 border border-emerald-100 p-3"><div className="text-xs font-semibold text-emerald-800 mb-2">RÉUSSI · A/B</div><div className="flex flex-wrap gap-1.5">{passed.map((s) => <span key={s.id} className="status-badge grade-a">{displayStudent(s.first_name, s.last_name)}</span>)}{!passed.length ? <span className="text-xs muted">Aucun</span> : null}</div></div>
                <div className="rounded-xl bg-red-50 border border-red-100 p-3"><div className="text-xs font-semibold text-red-800 mb-2">NON RÉUSSI · C/D/ABSENCE</div><div className="flex flex-wrap gap-1.5">{failed.map((s) => <span key={s.id} className="status-badge grade-d">{displayStudent(s.first_name, s.last_name)}</span>)}{!failed.length ? <span className="text-xs muted">Aucun</span> : null}</div></div>
                <div className="rounded-xl bg-gray-50 border border-gray-200 p-3"><div className="text-xs font-semibold text-gray-600 mb-2">EN COURS</div><div className="flex flex-wrap gap-1.5">{pending.map((s) => <span key={s.id} className="status-badge grade-empty">{displayStudent(s.first_name, s.last_name)}</span>)}{!pending.length ? <span className="text-xs muted">Aucun</span> : null}</div></div>
              </div>
            </section>
          ))}
        </div>
      )}

      <Modal open={Boolean(selected)} onClose={() => { setSelected(null); setError(''); }} title={selected ? `${displayStudent(selected.student.first_name, selected.student.last_name)} · ${selected.evaluation.name}` : 'Modifier la note'}>
        {selected ? (
          <form className="space-y-4" onSubmit={saveGrade}>
            <div className="rounded-xl bg-gray-50 p-3 text-xs muted">Saisissez une mention (A, B, C ou D), un résultat de rattrapage comme <strong>C/B</strong>, ou renseignez une absence ci-dessous.</div>
            <label className="block"><span className="form-label">Mention / rattrapage</span><input name="mention" className="form-input" defaultValue={selected.grade?.raw_mention || ''} placeholder="A, B, C, D ou C/B" /></label>
            <label className="block"><span className="form-label">Note numérique / détail</span><input name="numeric" className="form-input" defaultValue={selected.grade?.numeric_note_text || ''} placeholder="ex. 8,5 / 20 ou DS : ..." /></label>
            <label className="block"><span className="form-label">Absence</span><select name="absence" className="form-select" defaultValue={selected.grade?.absence || ''}><option value="">Aucune</option><option value="AJ">AJ — absence justifiée</option><option value="ANJ">ANJ — absence injustifiée</option></select></label>
            {error ? <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div> : null}
            <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setSelected(null)}>Annuler</button><button className="btn-primary">Enregistrer</button></div>
          </form>
        ) : null}
      </Modal>

      <Modal open={Boolean(selectedStudent)} onClose={() => { setSelectedStudent(null); setError(''); }} title="Modifier l’étudiant">
        {selectedStudent ? (
          <form className="space-y-4" onSubmit={saveStudent}>
            <div className="grid grid-cols-2 gap-3">
              <label className="block"><span className="form-label">Prénom</span><input name="first_name" className="form-input" defaultValue={selectedStudent.first_name} required /></label>
              <label className="block"><span className="form-label">Nom</span><input name="last_name" className="form-input" defaultValue={selectedStudent.last_name} required /></label>
            </div>
            <label className="block"><span className="form-label">Option</span><input name="option_name" className="form-input" defaultValue={selectedStudent.option_name || ''} /></label>
            <label className="block"><span className="form-label">Infos complémentaires · facultatif</span><textarea name="supplementary_info" className="form-input min-h-[120px]" defaultValue={selectedStudent.supplementary_info || ''} /></label>
            {error ? <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div> : null}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-2">
              <button type="button" className="btn-danger" onClick={deleteStudent}><Trash2 size={15} /> Supprimer l’étudiant</button>
              <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setSelectedStudent(null)}>Annuler</button><button className="btn-primary">Enregistrer</button></div>
            </div>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}
