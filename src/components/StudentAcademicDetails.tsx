'use client';

import { useMemo } from 'react';
import type { Debt, Evaluation, Grade, Student, UE } from '@/lib/types';
import { computeStudentUEs, makeGradeMap, makeInferredBlankAbsenceSet } from '@/lib/results';
import { GradeBadge } from '@/components/Badge';

function statusClass(validated: boolean, missing: boolean) {
  if (missing) return 'grade-empty';
  return validated ? 'grade-a' : 'grade-d';
}


export default function StudentAcademicDetails({
  student,
  students,
  ues,
  evaluations,
  grades,
  debts = [],
}: {
  student: Student;
  students: Student[];
  ues: UE[];
  evaluations: Evaluation[];
  grades: Grade[];
  debts?: Debt[];
}) {
  const data = useMemo(() => {
    const activeStudents = students.filter((item) => item.active !== false);
    const gradeMap = makeGradeMap(grades);
    const inferredBlankAbsences = makeInferredBlankAbsenceSet(activeStudents, evaluations, grades);
    const results = computeStudentUEs(student.id, ues, evaluations, gradeMap, inferredBlankAbsences)
      .sort((a, b) => {
        const rankA = !a.missing && !a.validated ? 0 : a.missing ? 1 : 2;
        const rankB = !b.missing && !b.validated ? 0 : b.missing ? 1 : 2;
        return rankA - rankB || a.ue.semester - b.ue.semester || a.ue.name.localeCompare(b.ue.name);
      });
    const unlinked = evaluations
      .filter((evaluation) => !evaluation.ue_id)
      .sort((a, b) => a.semester - b.semester || a.name.localeCompare(b.name))
      .map((evaluation) => {
        const key = `${student.id}:${evaluation.id}`;
        return {
          evaluation,
          grade: gradeMap.get(key) || null,
          inferredAbsence: inferredBlankAbsences.has(key),
        };
      });
    const studentDebts = debts.filter((debt) => debt.student_id === student.id);
    return { results, unlinked, studentDebts };
  }, [student, students, ues, evaluations, grades, debts]);

  const problemCount = data.results.filter((result) => !result.missing && !result.validated).length;
  const absenceCount = data.results.reduce((sum, result) => sum + result.elements.filter((element) => element.inferredAbsence || element.grade?.absence).length, 0)
    + data.unlinked.filter((element) => element.inferredAbsence || element.grade?.absence).length;

  return (
    <div className="space-y-5">
      <div className="grid sm:grid-cols-3 gap-3">
        <div className="rounded-xl bg-gray-50 p-4"><div className="text-xs uppercase font-semibold muted">UE non validées</div><div className="text-2xl font-semibold mt-1">{problemCount}</div></div>
        <div className="rounded-xl bg-gray-50 p-4"><div className="text-xs uppercase font-semibold muted">Absences</div><div className="text-2xl font-semibold mt-1">{absenceCount}</div></div>
        <div className="rounded-xl bg-gray-50 p-4"><div className="text-xs uppercase font-semibold muted">Dettes</div><div className="text-2xl font-semibold mt-1">{data.studentDebts.filter((debt) => debt.status === 'pending').length}</div></div>
      </div>

      <div className="space-y-3">
        {data.results.map((result) => (
          <section key={result.ue.id} className={`rounded-2xl border p-4 ${result.missing ? 'bg-gray-50 border-gray-200' : result.validated ? 'bg-emerald-50/50 border-emerald-200' : 'bg-red-50/50 border-red-200'}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="font-semibold">{result.ue.name}</div>
                <div className="text-xs muted mt-1">S{result.ue.semester}{result.ue.ects != null ? ` · ${result.ue.ects} ECTS` : ''}{result.ue.exclude_from_jury ? ' · Exclue du jury' : ''}</div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`status-badge ${statusClass(result.validated, result.missing)}`}>{result.missing ? 'En cours' : result.validated ? 'Validée' : 'Non validée'}</span>
                {result.mention ? <span className={`status-badge ${result.mention === 'A' ? 'grade-a' : result.mention === 'B' ? 'grade-b' : result.mention === 'C' ? 'grade-c' : 'grade-d'} font-semibold`}>{result.mention}</span> : null}
              </div>
            </div>
            {result.weightedAverage != null ? <div className="text-xs mt-2">Moyenne UE : <strong>{result.weightedAverage.toFixed(1)}</strong>{result.compensation ? ' · validée par compensation' : ''}</div> : null}
            <div className="mt-3 border-t divide-y" style={{ borderColor: 'var(--border)' }}>
              {result.elements.map((element) => (
                <div key={element.evaluation.id} className="py-2.5 flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-sm">{element.evaluation.name}</div>
                    <div className="text-[11px] muted mt-0.5">coef {Number(element.evaluation.coefficient || 1)}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {element.inferredAbsence ? <span className="status-badge grade-absence">Absence</span> : <GradeBadge grade={element.grade} compact />}
                    {element.grade?.numeric_note_text ? <span className="text-xs font-medium tabular-nums">{element.grade.numeric_note_text}</span> : null}
                    {element.grade?.raw_mention?.includes('/') ? <span className="text-[11px] muted">{element.grade.raw_mention}</span> : null}
                  </div>
                </div>
              ))}
              {!result.elements.length ? <div className="py-3 text-sm muted">Aucune matière rattachée.</div> : null}
            </div>
          </section>
        ))}
      </div>

      {data.unlinked.length ? (
        <section className="rounded-2xl border border-gray-200 bg-white p-4">
          <div className="font-semibold">Matières non rattachées à une UE</div>
          <div className="mt-3 divide-y" style={{ borderColor: 'var(--border)' }}>
            {data.unlinked.map((element) => (
              <div key={element.evaluation.id} className="py-2.5 flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between">
                <div><div className="text-sm">{element.evaluation.name}</div><div className="text-[11px] muted">S{element.evaluation.semester}</div></div>
                <div className="flex items-center gap-2">
                  {element.inferredAbsence ? <span className="status-badge grade-absence">Absence</span> : <GradeBadge grade={element.grade} compact />}
                  {element.grade?.numeric_note_text ? <span className="text-xs font-medium tabular-nums">{element.grade.numeric_note_text}</span> : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {data.studentDebts.length ? (
        <section className="rounded-2xl border border-gray-200 bg-white p-4">
          <div className="font-semibold">Dettes</div>
          <div className="mt-3 space-y-2">
            {data.studentDebts.map((debt) => {
              const ue = ues.find((item) => item.id === debt.ue_id);
              return <div key={debt.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-gray-50 px-3 py-2.5 text-sm"><span>{ue?.name || 'UE'} · {debt.origin_year_label}</span><span className={`status-badge ${debt.status === 'validated' ? 'grade-a' : 'grade-d'}`}>{debt.status === 'validated' ? 'Dette validée' : 'Dette non validée'}</span></div>;
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
