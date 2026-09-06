'use client';

import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Filter, ListFilter, Pencil, RefreshCw, Search } from 'lucide-react';
import * as XLSX from 'xlsx';
import { getSupabaseBrowser } from '@/lib/supabase/client';
import { fetchAllRows } from '@/lib/supabase/fetchAll';
import type { CesiSession, Debt, Evaluation, Grade, JuryComputed, JuryOpinion, JuryRecord, Preconisation, Student, UE } from '@/lib/types';
import { computeJury, defaultPreconisations, opinionLabel } from '@/lib/results';
import { cycleYears, displayStudent, normalizeText, yearToSemesters } from '@/lib/utils';
import SessionSelect from '@/components/SessionSelect';
import Loading from '@/components/Loading';
import Modal from '@/components/Modal';
import { OpinionBadge } from '@/components/Badge';
import StudentAcademicDetails from '@/components/StudentAcademicDetails';

type JuryRow = {
  student: Student;
  record: JuryRecord | null;
  computed: JuryComputed;
  effective: JuryOpinion | null;
  hasPreviousJury: boolean;
  selectedPrecos: number[];
};

export default function JuryPage() {
  const supabase = useMemo(() => getSupabaseBrowser(), []);
  const [sessions, setSessions] = useState<CesiSession[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [yearLabel, setYearLabel] = useState('A4');
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
  const [detailsRow, setDetailsRow] = useState<JuryRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [activeRowId, setActiveRowId] = useState('');
  const [error, setError] = useState('');
  const [ueExclusionSearch, setUeExclusionSearch] = useState('');

  const loadSessions = useCallback(async () => {
    const { data } = await supabase.from('sessions').select('*').order('name');
    const rows = (data || []) as CesiSession[];
    setSessions(rows);
    if (!sessionId && rows.length) {
      setSessionId(rows[0].id);
      setYearLabel(cycleYears(rows[0].cycle)[0].label);
    }
  }, [supabase, sessionId]);

  const loadData = useCallback(async () => {
    if (!sessionId) { setLoading(false); return; }
    setLoading(true);
    setError('');
    try {
      const session = sessions.find((item) => item.id === sessionId);
      let effectiveYearLabel = yearLabel;
      if (session && !cycleYears(session.cycle).some((year) => year.label === yearLabel)) {
        effectiveYearLabel = cycleYears(session.cycle)[0].label;
        setYearLabel(effectiveYearLabel);
      }
      const semesters = yearToSemesters(effectiveYearLabel);

      // Les dettes sont recalculées avant le jury afin que le tableau utilise toujours
      // l'état académique actuel, y compris après un nouvel import de notes.
      const { data: authSession } = await supabase.auth.getSession();
      if (authSession.session) {
        await fetch('/api/debts/sync', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Authorization: `Bearer ${authSession.session.access_token}`,
          },
          body: JSON.stringify({ session_id: sessionId }),
        });
      }

      const [studentRows, evalRows, ueRows, precoRows] = await Promise.all([
        fetchAllRows<Student>((from, to) => supabase
          .from('students')
          .select('*')
          .eq('session_id', sessionId)
          .eq('active', true)
          .order('last_name')
          .order('first_name')
          .order('id')
          .range(from, to)),
        fetchAllRows<Evaluation>((from, to) => supabase
          .from('evaluations')
          .select('*')
          .eq('session_id', sessionId)
          .in('semester', semesters)
          .eq('active', true)
          .order('semester')
          .order('name')
          .order('id')
          .range(from, to)),
        fetchAllRows<UE>((from, to) => supabase
          .from('ues')
          .select('*')
          .eq('session_id', sessionId)
          .in('semester', semesters)
          .eq('active', true)
          .order('semester')
          .order('name')
          .order('id')
          .range(from, to)),
        fetchAllRows<Preconisation>((from, to) => supabase
          .from('preconisations')
          .select('*')
          .order('id')
          .range(from, to)),
      ]);

      const evaluationIds = evalRows.map((evaluation) => evaluation.id);
      let gradeRows: Grade[] = [];
      if (evaluationIds.length) {
        gradeRows = await fetchAllRows<Grade>((from, to) => supabase
          .from('grades')
          .select('*')
          .in('evaluation_id', evaluationIds)
          .order('id')
          .range(from, to));
      }

      const studentIds = studentRows.map((student) => student.id);
      let debtRows: Debt[] = [];
      let recordRows: JuryRecord[] = [];
      if (studentIds.length) {
        [debtRows, recordRows] = await Promise.all([
          fetchAllRows<Debt>((from, to) => supabase
            .from('debts')
            .select('*')
            .in('student_id', studentIds)
            .order('id')
            .range(from, to)),
          fetchAllRows<JuryRecord>((from, to) => supabase
            .from('jury_records')
            .select('*')
            .in('student_id', studentIds)
            .order('id')
            .range(from, to)),
        ]);
      }

      const recordIds = recordRows.map((record) => record.id);
      let linkRows: Array<{ jury_record_id: string; preconisation_id: number }> = [];
      if (recordIds.length) {
        linkRows = await fetchAllRows<{ jury_record_id: string; preconisation_id: number }>((from, to) => supabase
          .from('jury_preconisations')
          .select('jury_record_id,preconisation_id')
          .in('jury_record_id', recordIds)
          .order('jury_record_id')
          .order('preconisation_id')
          .range(from, to));
      }

      setStudents(studentRows);
      setEvaluations(evalRows);
      setUes(ueRows);
      setGrades(gradeRows);
      setDebts(debtRows);
      setRecords(recordRows);
      setPreconisations(precoRows);
      setLinks(linkRows);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Lecture impossible.');
    } finally {
      setLoading(false);
    }
  }, [supabase, sessionId, yearLabel, sessions]);

  useEffect(() => { loadSessions(); }, [loadSessions]);
  useEffect(() => { if (sessions.length) loadData(); }, [loadData, sessions.length]);

  const currentSession = sessions.find((s) => s.id === sessionId);
  const juryUes = useMemo(() => ues.filter((ue) => !ue.exclude_from_jury), [ues]);
  const filteredUesForExclusion = useMemo(() => {
    const term = normalizeText(ueExclusionSearch);
    return ues.filter((ue) => !term || normalizeText(ue.name).includes(term));
  }, [ues, ueExclusionSearch]);

  const rows = useMemo<JuryRow[]>(() => students.map((student) => {
    const record = records.find((r) => r.student_id === student.id && r.year_label === yearLabel) || null;
    const computed = computeJury(student, yearLabel, evaluations, juryUes, grades, debts, record, students);
    const yearNumber = Number(yearLabel.slice(1));
    const hasPreviousJury = records.some((r) => r.student_id === student.id && Number(r.year_label.slice(1)) < yearNumber);
    const selectedPrecos = record ? links.filter((l) => l.jury_record_id === record.id).map((l) => l.preconisation_id) : [];
    return {
      student,
      record,
      computed,
      effective: record?.opinion_override || computed.automaticOpinion,
      hasPreviousJury,
      selectedPrecos,
    };
  }), [students, records, yearLabel, evaluations, juryUes, grades, debts, links]);

  const shownRows = rows.filter((r) => !complexOnly
    || r.computed.totalUeNotValidated > 0
    || r.computed.pendingPreviousDebts > 0
    || r.computed.validatedPreviousDebts > 0
    || r.computed.absences > 0
    || r.record?.major_behavior_issue
    || (r.record && !r.record.previous_recommendations_respected)
    || r.effective === 'reserve'
    || r.effective === 'defavorable');

  async function saveJury(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editing) return;
    setSaving(true);
    setError('');
    const fd = new FormData(e.currentTarget);
    const overrideRaw = String(fd.get('opinion') || 'auto');
    const major = fd.get('major_behavior_issue') === 'on';
    const previousRespected = fd.get('previous_recommendations_respected') === 'on';
    const supplement = String(fd.get('supplementary_info') || '').trim() || null;
    const notes = String(fd.get('jury_notes') || '').trim() || null;
    const selected = preconisations.filter((p) => fd.get(`preco-${p.id}`) === 'on').map((p) => p.id);
    const { data: auth } = await supabase.auth.getUser();
    const payload = {
      student_id: editing.student.id,
      year_label: yearLabel,
      opinion_override: overrideRaw === 'auto' ? null : overrideRaw as JuryOpinion,
      major_behavior_issue: major,
      previous_recommendations_respected: previousRespected,
      supplementary_notes: notes,
      preconisations_locked: true,
      created_by: auth.user?.id || null,
    };
    const rec = await supabase.from('jury_records').upsert(payload, { onConflict: 'student_id,year_label' }).select('*').single();
    if (rec.error) { setError(rec.error.message); setSaving(false); return; }
    const upd = await supabase.from('students').update({ supplementary_info: supplement }).eq('id', editing.student.id);
    if (upd.error) { setError(upd.error.message); setSaving(false); return; }
    await supabase.from('jury_preconisations').delete().eq('jury_record_id', rec.data.id);
    if (selected.length) {
      const updatedRecord = { ...rec.data, major_behavior_issue: major, previous_recommendations_respected: previousRespected } as JuryRecord;
      const autoComputed = computeJury(editing.student, yearLabel, evaluations, juryUes, grades, debts, updatedRecord, students);
      const autoIds = new Set(defaultPreconisations(autoComputed, updatedRecord, editing.hasPreviousJury));
      const ins = await supabase.from('jury_preconisations').insert(selected.map((id) => ({ jury_record_id: rec.data.id, preconisation_id: id, is_auto: autoIds.has(id) })));
      if (ins.error) { setError(ins.error.message); setSaving(false); return; }
    }
    setSaving(false);
    setEditing(null);
    await loadData();
  }

  async function setQuickOpinion(row: JuryRow, opinion: JuryOpinion) {
    setActiveRowId(row.student.id);
    const { data: auth } = await supabase.auth.getUser();
    if (row.record) {
      await supabase.from('jury_records').update({ opinion_override: opinion }).eq('id', row.record.id);
    } else {
      await supabase.from('jury_records').insert({
        student_id: row.student.id,
        year_label: yearLabel,
        opinion_override: opinion,
        major_behavior_issue: false,
        previous_recommendations_respected: true,
        supplementary_notes: null,
        created_by: auth.user?.id || null,
      });
    }
    await loadData();
  }

  function handleRowKey(event: KeyboardEvent<HTMLTableRowElement>, row: JuryRow) {
    const target = event.target as HTMLElement;
    if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName)) return;
    const key = event.key.toLowerCase();
    const map: Record<string, JuryOpinion> = {
      f: 'favorable',
      r: 'reserve',
      d: 'defavorable',
      i: 'indetermine',
    };
    if (!map[key]) return;
    event.preventDefault();
    void setQuickOpinion(row, map[key]);
  }

  async function toggleUeJury(ue: UE) {
    const { error: updateError } = await supabase
      .from('ues')
      .update({ exclude_from_jury: !ue.exclude_from_jury })
      .eq('id', ue.id);
    if (updateError) { setError(updateError.message); return; }
    setUes((current) => current.map((item) => item.id === ue.id ? { ...item, exclude_from_jury: !item.exclude_from_jury } : item));
  }

  async function includeAllUes() {
    if (!sessionId) return;
    const semesters = yearToSemesters(yearLabel);
    const { error: updateError } = await supabase
      .from('ues')
      .update({ exclude_from_jury: false })
      .eq('session_id', sessionId)
      .in('semester', semesters);
    if (updateError) { setError(updateError.message); return; }
    setUes((current) => current.map((ue) => ({ ...ue, exclude_from_jury: false })));
  }

  function preconisationIdsFor(row: JuryRow) {
    return row.record?.preconisations_locked || row.selectedPrecos.length > 0
      ? row.selectedPrecos
      : defaultPreconisations(row.computed, row.record, row.hasPreviousJury);
  }

  function exportJury() {
    const precoById = new Map<number, Preconisation>(preconisations.map((p) => [p.id, p]));
    const exportRows = rows.map((row) => {
      const ids = preconisationIdsFor(row);
      const semesters = yearToSemesters(yearLabel);
      const status = (semester: number) => row.computed.semesterValidated[semester] === true
        ? 'Validé'
        : row.computed.semesterValidated[semester] === false
          ? 'Non validé'
          : 'En cours';
      return {
        Prénom: row.student.first_name,
        Nom: row.student.last_name,
        Année: yearLabel,
        [`S${semesters[0]}`]: status(semesters[0]),
        [`S${semesters[1]}`]: status(semesters[1]),
        'ECTS acquis': row.computed.ectsAcquired,
        'UE finalisées': row.computed.finalizedUeCount,
        'UE non validées': row.computed.totalUeNotValidated,
        'UE académiques non validées': row.computed.academicUeNotValidated,
        Rattrapages: row.computed.resitCount,
        'Rattrapages validés': row.computed.resitValidatedCount,
        'Dettes antérieures non validées': row.computed.pendingPreviousDebts,
        'Ex-dettes': row.computed.validatedPreviousDebts,
        Avis: opinionLabel(row.effective),
        'Préconisations — numéros': ids.map((id) => `#${id}`).join(', '),
        'Préconisations — textes': ids.map((id) => precoById.get(id)?.text || '').filter(Boolean).join(' | '),
        'Infos complémentaires': row.student.supplementary_info || '',
        'Notes jury': row.record?.supplementary_notes || '',
      };
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(exportRows), `Jury ${yearLabel}`);
    XLSX.writeFile(wb, `jury_${currentSession?.analytic_code || 'session'}_${yearLabel}.xlsx`);
  }

  if (loading && !sessions.length) return <Loading />;

  const semesters = yearToSemesters(yearLabel);

  return <div className="space-y-6">
    <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-4">
      <div><h1 className="page-title">Jury</h1><p className="page-subtitle">Préparation et suivi des avis par année.</p></div>
      <div className="flex flex-wrap items-end gap-3">
        <SessionSelect sessions={sessions} value={sessionId} onChange={(id) => { setSessionId(id); const s = sessions.find((x) => x.id === id); if (s) setYearLabel(cycleYears(s.cycle)[0].label); }} />
        <label className="block min-w-[115px]"><span className="form-label">Année</span><select className="form-select" value={yearLabel} onChange={(e) => setYearLabel(e.target.value)}>{currentSession ? cycleYears(currentSession.cycle).map((y) => <option key={y.label} value={y.label}>{y.label}</option>) : null}</select></label>
        <details className="relative">
          <summary className="btn-secondary list-none cursor-pointer"><ListFilter size={16} /> UE exclues {ues.filter((ue) => ue.exclude_from_jury).length ? <span className="status-badge grade-empty !py-0">{ues.filter((ue) => ue.exclude_from_jury).length}</span> : null}</summary>
          <div className="absolute right-0 z-40 mt-2 w-[min(92vw,480px)] card p-3 shadow-xl">
            <div className="flex items-center justify-between gap-3 px-1 pb-2 border-b" style={{ borderColor: 'var(--border)' }}>
              <div className="text-sm font-semibold">UE prises en compte par le jury</div>
              <button type="button" className="text-xs text-blue-600 font-medium" onClick={includeAllUes}>Tout réinclure</button>
            </div>
            <label className="relative block mt-3"><Search size={15} className="absolute left-3 top-3 text-gray-400" /><input className="form-input !pl-9" placeholder="Rechercher une UE…" value={ueExclusionSearch} onChange={(e) => setUeExclusionSearch(e.target.value)} /></label>
            <div className="max-h-[360px] overflow-auto mt-2 space-y-1">
              {filteredUesForExclusion.map((ue) => <label key={ue.id} className="flex items-start gap-3 rounded-xl px-3 py-2.5 hover:bg-gray-50 cursor-pointer"><input type="checkbox" className="mt-0.5" checked={!ue.exclude_from_jury} onChange={() => toggleUeJury(ue)} /><span className="min-w-0 text-sm"><span className="block">{ue.name}</span><span className="text-[11px] muted">S{ue.semester}</span></span></label>)}
              {!filteredUesForExclusion.length ? <div className="px-3 py-6 text-center text-sm muted">Aucune UE trouvée.</div> : null}
            </div>
          </div>
        </details>
        <button className="btn-secondary" onClick={() => loadData()}><RefreshCw size={16} /> Actualiser</button>
        <button className="btn-primary" onClick={exportJury} disabled={!rows.length}><Download size={16} /> Export Excel</button>
      </div>
    </div>

    {error ? <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div> : null}

    <div className="card p-4 flex flex-wrap items-center justify-between gap-4">
      <label className="inline-flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={complexOnly} onChange={(e) => setComplexOnly(e.target.checked)} className="rounded" /><Filter size={15} /> N’afficher que les cas complexes</label>
      <div className="text-xs muted">Cliquez sur une ligne puis utilisez <strong>F</strong> favorable · <strong>R</strong> réservé · <strong>D</strong> défavorable · <strong>I</strong> indéterminé.</div>
    </div>

    {!ues.length && !loading ? <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">Aucun référentiel trouvé pour {yearLabel}.</div> : null}
    {ues.length > 0 && !juryUes.length && !loading ? <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">Toutes les UE de {yearLabel} sont exclues du calcul du jury.</div> : null}

    {loading ? <Loading /> : <section className="card overflow-hidden"><div className="overflow-auto"><table className="min-w-full border-collapse"><thead><tr><th className="table-header">Étudiant</th><th className="table-header">S{semesters[0]}</th><th className="table-header">S{semesters[1]}</th><th className="table-header">ECTS acquis</th><th className="table-header">UE finalisées non validées</th><th className="table-header">Rattrapages</th><th className="table-header">Dettes</th><th className="table-header">Avis</th><th className="table-header">Préconisations</th><th className="table-header"></th></tr></thead><tbody>{shownRows.map((r) => {
      const defaultIds = preconisationIdsFor(r);
      return <tr
        key={r.student.id}
        tabIndex={0}
        onFocus={() => setActiveRowId(r.student.id)}
        onClick={() => setActiveRowId(r.student.id)}
        onKeyDown={(event) => handleRowKey(event, r)}
        className={`border-t align-top outline-none transition-colors ${activeRowId === r.student.id ? 'bg-blue-50/60 ring-1 ring-inset ring-blue-200' : 'hover:bg-gray-50/70'}`}
        style={{ borderColor:'var(--border)' }}
      >
        <td className="table-cell font-medium whitespace-nowrap"><button type="button" className="text-left font-medium hover:text-blue-600 hover:underline underline-offset-2" onClick={(event) => { event.stopPropagation(); setDetailsRow(r); }}>{displayStudent(r.student.first_name, r.student.last_name)}</button>{r.student.supplementary_info ? <div className="text-xs muted mt-1 max-w-[250px] whitespace-normal">{r.student.supplementary_info}</div> : null}</td>
        {semesters.map((s) => <td key={s} className="table-cell"><span className={`status-badge ${r.computed.semesterValidated[s] === true ? 'grade-a' : r.computed.semesterValidated[s] === false ? 'grade-d' : 'grade-empty'}`}>{r.computed.semesterValidated[s] === true ? 'Validé' : r.computed.semesterValidated[s] === false ? 'Non validé' : 'En cours'}</span></td>)}
        <td className="table-cell font-medium">{r.computed.ectsAcquired}</td>
        <td className="table-cell">{r.computed.totalUeNotValidated} <span className="text-xs muted">({r.computed.academicUeNotValidated} acad.)</span></td>
        <td className="table-cell"><span className="whitespace-nowrap"><strong>{r.computed.resitCount}</strong> <span className="text-xs muted">dont {r.computed.resitValidatedCount} validé{r.computed.resitValidatedCount > 1 ? 's' : ''}</span></span></td>
        <td className="table-cell"><span className={r.computed.pendingPreviousDebts ? 'text-red-600 font-semibold' : ''}>{r.computed.pendingPreviousDebts}</span> <span className="text-xs muted">+ {r.computed.validatedPreviousDebts} ex</span></td>
        <td className="table-cell"><OpinionBadge opinion={r.effective} /></td>
        <td className="table-cell"><div className="flex flex-wrap gap-1 max-w-[220px]">{defaultIds.map((id) => <span key={id} className="status-badge grade-empty font-semibold">#{id}</span>)}{!defaultIds.length ? <span className="muted">—</span> : null}</div></td>
        <td className="table-cell text-right"><button className="btn-secondary !p-2" onClick={(event) => { event.stopPropagation(); setEditing(r); }} title="Modifier"><Pencil size={15} /></button></td>
      </tr>;
    })}{!shownRows.length ? <tr><td colSpan={10} className="p-10 text-center text-sm muted">Aucun étudiant ne correspond au filtre.</td></tr> : null}</tbody></table></div></section>}

    <Modal open={Boolean(detailsRow)} onClose={() => setDetailsRow(null)} title={detailsRow ? `${displayStudent(detailsRow.student.first_name, detailsRow.student.last_name)} · Détail académique ${yearLabel}` : 'Détail académique'} wide>
      {detailsRow ? <StudentAcademicDetails student={detailsRow.student} students={students} ues={ues} evaluations={evaluations} grades={grades} debts={debts} /> : null}
    </Modal>

    <Modal open={Boolean(editing)} onClose={() => { setEditing(null); setError(''); }} title={editing ? `${displayStudent(editing.student.first_name, editing.student.last_name)} · Jury ${yearLabel}` : 'Jury'} wide>
      {editing ? (() => {
        const initialIds = preconisationIdsFor(editing);
        return <form className="space-y-6" onSubmit={saveJury}>
          <div className="grid md:grid-cols-3 gap-3"><div className="rounded-xl bg-gray-50 p-4"><div className="text-xs uppercase font-semibold muted">Avis automatique</div><div className="mt-2"><OpinionBadge opinion={editing.computed.automaticOpinion} /></div></div><div className="rounded-xl bg-gray-50 p-4"><div className="text-xs uppercase font-semibold muted">ECTS acquis</div><div className="text-xl font-semibold mt-1">{editing.computed.ectsAcquired}</div></div><div className="rounded-xl bg-gray-50 p-4"><div className="text-xs uppercase font-semibold muted">Points à surveiller</div><div className="text-xs mt-1">{editing.computed.reasons.join(' · ') || 'Aucun signal automatique'}</div></div></div><div className="rounded-xl border border-blue-200 bg-blue-50/70 p-4"><div className="text-xs uppercase font-semibold text-blue-700">Pourquoi cet avis automatique ?</div><div className="text-sm mt-1.5 text-blue-950">{editing.computed.automaticOpinionReason}</div></div>
          <div className="grid md:grid-cols-2 gap-4"><label className="block"><span className="form-label">Avis retenu</span><select name="opinion" className="form-select" defaultValue={editing.record?.opinion_override || 'auto'}><option value="auto">Automatique — {opinionLabel(editing.computed.automaticOpinion)}</option><option value="favorable">Avis favorable</option><option value="reserve">Avis réservé</option><option value="defavorable">Avis défavorable</option><option value="indetermine">Indéterminé</option></select></label><div className="space-y-3 pt-1"><label className="flex items-start gap-2 text-sm"><input name="major_behavior_issue" type="checkbox" defaultChecked={editing.record?.major_behavior_issue || false} className="mt-1" /><span><strong>Écart de comportement majeur</strong></span></label><label className="flex items-start gap-2 text-sm"><input name="previous_recommendations_respected" type="checkbox" defaultChecked={editing.record?.previous_recommendations_respected ?? true} className="mt-1" /><span><strong>Préconisations du jury précédent respectées</strong></span></label></div></div>
          <div className="grid lg:grid-cols-2 gap-4"><label className="block"><span className="form-label">Infos complémentaires étudiant · facultatif</span><textarea name="supplementary_info" className="form-input min-h-[120px]" defaultValue={editing.student.supplementary_info || ''} placeholder="Information utile, contexte particulier…" /></label><label className="block"><span className="form-label">Notes internes du jury · facultatif</span><textarea name="jury_notes" className="form-input min-h-[120px]" defaultValue={editing.record?.supplementary_notes || ''} placeholder="Commentaires propres à ce jury…" /></label></div>
          <div><div className="flex items-center justify-between gap-4 mb-3"><div><h3 className="font-semibold">Préconisations</h3>{editing.computed.toeicScore !== null ? <div className="text-xs muted mt-1">Dernier score TOEIC détecté : <strong>{editing.computed.toeicScore}/990</strong>{editing.computed.toeicScore < 785 ? ' · objectif 785 non atteint' : ' · objectif 785 atteint'}</div> : null}</div></div><div className="grid md:grid-cols-2 gap-2">{preconisations.map((p) => <label key={p.id} className={`rounded-xl border p-3 flex items-start gap-3 cursor-pointer ${initialIds.includes(p.id) ? 'bg-blue-50 border-blue-200' : 'bg-white'}`}><input name={`preco-${p.id}`} type="checkbox" defaultChecked={initialIds.includes(p.id)} className="mt-1" /><span className="status-badge grade-b shrink-0 font-bold">#{p.id}</span><span className="text-sm"><strong className="text-xs uppercase tracking-wide">{p.category}</strong><br/>{p.text}</span></label>)}</div></div>
          {error ? <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div> : null}<div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setEditing(null)}>Annuler</button><button className="btn-primary" disabled={saving}>{saving ? 'Enregistrement…' : 'Enregistrer le jury'}</button></div>
        </form>;
      })() : null}
    </Modal>
  </div>;
}
