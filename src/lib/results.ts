import type {
  Debt,
  Evaluation,
  Grade,
  JuryComputed,
  JuryOpinion,
  JuryRecord,
  Student,
  UE,
  UEComputedResult,
} from './types';
import { semesterToYear, yearToSemesters } from './utils';

export const GRADE_VALUES: Record<string, number> = { A: 5, B: 4, C: 2, D: 1 };

export function parseMention(rawValue: unknown) {
  const raw = rawValue === null || rawValue === undefined ? '' : String(rawValue).trim().toUpperCase();
  if (!raw) return { raw: null, initial: null, final: null, absence: null as 'AJ' | 'ANJ' | null, hadResit: false };
  if (raw === 'AJ' || raw === 'ANJ') {
    return { raw, initial: null, final: null, absence: raw, hadResit: false } as const;
  }
  const parts = raw.split('/').map((x) => x.trim()).filter(Boolean);
  const letters = parts.filter((x) => ['A', 'B', 'C', 'D'].includes(x));
  const initial = letters.length ? letters[0] : null;
  const final = letters.length ? letters[letters.length - 1] : null;
  return { raw, initial, final, absence: null as 'AJ' | 'ANJ' | null, hadResit: raw.includes('/') };
}

export function gradeValue(grade: Grade | null | undefined): number | null {
  if (!grade) return null;
  if (grade.final_mention && GRADE_VALUES[grade.final_mention] !== undefined) return GRADE_VALUES[grade.final_mention];
  if (grade.absence === 'AJ' || grade.absence === 'ANJ') return GRADE_VALUES.D;
  return null;
}

export function gradeNeedsRetake(grade: Grade | null | undefined) {
  if (!grade) return false;
  if (grade.absence === 'AJ' || grade.absence === 'ANJ') return true;
  return grade.final_mention === 'C' || grade.final_mention === 'D';
}

export function gradeHadResit(grade: Grade | null | undefined) {
  return Boolean(grade?.raw_mention?.includes('/'));
}

export function gradeTooltip(grade: Grade | null | undefined): string {
  if (!grade) return 'Note non saisie';
  const lines: string[] = [];
  if (grade.numeric_note_text) lines.push(`Note numérique : ${grade.numeric_note_text}`);
  if (grade.raw_mention?.includes('/')) lines.push(`Rattrapage : ${grade.raw_mention}`);
  if (grade.absence) lines.push(`Absence : ${grade.absence}`);
  return lines.length ? lines.join(' · ') : 'Aucune note numérique disponible';
}

export function makeGradeMap(grades: Grade[]) {
  return new Map(grades.map((g) => [`${g.student_id}:${g.evaluation_id}`, g] as const));
}

export function computeStudentUE(
  studentId: string,
  ue: UE,
  evaluations: Evaluation[],
  gradeMap: Map<string, Grade>,
): UEComputedResult {
  const elements = evaluations
    .filter((e) => e.ue_id === ue.id && e.active)
    .map((evaluation) => {
      const grade = gradeMap.get(`${studentId}:${evaluation.id}`) || null;
      return { evaluation, grade, value: gradeValue(grade) };
    });

  if (!elements.length) {
    return { ue, mention: null, weightedAverage: null, validated: false, compensation: false, missing: true, elements };
  }

  let weighted = 0;
  let coeffs = 0;
  let missing = false;
  for (const element of elements) {
    if (element.value === null) {
      missing = true;
      continue;
    }
    const coeff = Number(element.evaluation.coefficient || 1);
    weighted += element.value * coeff;
    coeffs += coeff;
  }

  if (!coeffs) {
    return { ue, mention: null, weightedAverage: null, validated: false, compensation: false, missing: true, elements };
  }

  const avg = Math.floor((weighted / coeffs) * 10) / 10;
  let mention: 'A' | 'B' | 'C' | 'D';
  let validated: boolean;
  if (avg >= 4.6) {
    mention = 'A';
    validated = true;
  } else if (avg >= 3.6) {
    mention = 'B';
    validated = true;
  } else if (avg < 1.6) {
    mention = 'D';
    validated = false;
  } else {
    mention = 'C';
    validated = false;
  }

  const compensation = validated && elements.some((e) => {
    const f = e.grade?.final_mention;
    return f === 'C' || f === 'D' || e.grade?.absence === 'AJ' || e.grade?.absence === 'ANJ';
  });

  return { ue, mention, weightedAverage: avg, validated, compensation, missing, elements };
}

export function computeStudentUEs(
  studentId: string,
  ues: UE[],
  evaluations: Evaluation[],
  gradeMap: Map<string, Grade>,
) {
  return ues.map((ue) => computeStudentUE(studentId, ue, evaluations, gradeMap));
}

export function isEvaluationCompensated(
  studentId: string,
  evaluation: Evaluation,
  ues: UE[],
  evaluations: Evaluation[],
  gradeMap: Map<string, Grade>,
) {
  if (!evaluation.ue_id) return false;
  const ue = ues.find((x) => x.id === evaluation.ue_id);
  if (!ue) return false;
  const result = computeStudentUE(studentId, ue, evaluations, gradeMap);
  return result.validated && result.compensation;
}

export function buildRetakeMap(
  students: Student[],
  evaluations: Evaluation[],
  grades: Grade[],
  ues: UE[],
) {
  const gradeMap = makeGradeMap(grades);
  const current = new Map<string, Student[]>();
  const failedAfterResit = new Map<string, Student[]>();

  for (const evaluation of evaluations.filter((e) => e.active)) {
    for (const student of students.filter((s) => s.active)) {
      const grade = gradeMap.get(`${student.id}:${evaluation.id}`);
      if (!gradeNeedsRetake(grade)) continue;
      if (isEvaluationCompensated(student.id, evaluation, ues, evaluations, gradeMap)) continue;
      const target = gradeHadResit(grade) ? failedAfterResit : current;
      const list = target.get(evaluation.id) || [];
      list.push(student);
      target.set(evaluation.id, list);
    }
  }
  return { current, failedAfterResit };
}

export function buildParallelGroups(evaluations: Evaluation[], currentRetakes: Map<string, Student[]>) {
  const active = evaluations.filter((e) => (currentRetakes.get(e.id)?.length || 0) > 0);
  const studentSets = new Map(active.map((e) => [e.id, new Set((currentRetakes.get(e.id) || []).map((s) => s.id))]));
  const compatible = (a: string, b: string) => {
    const sa = studentSets.get(a) || new Set<string>();
    const sb = studentSets.get(b) || new Set<string>();
    for (const id of sa) if (sb.has(id)) return false;
    return true;
  };

  const remaining = [...active];
  const groups: Evaluation[][] = [];
  while (remaining.length) {
    const group: Evaluation[] = [remaining[0]];
    for (const candidate of remaining.slice(1)) {
      if (group.every((existing) => compatible(candidate.id, existing.id))) group.push(candidate);
    }
    groups.push(group);
    const used = new Set(group.map((e) => e.id));
    for (let i = remaining.length - 1; i >= 0; i -= 1) {
      if (used.has(remaining[i].id)) remaining.splice(i, 1);
    }
  }
  return { groups, compatible, studentSets };
}

export function defaultPreconisations(
  computed: JuryComputed,
  record: JuryRecord | null,
  hasPreviousJury: boolean,
  absenceThreshold: number,
): number[] {
  const ids = new Set<number>();
  if (record?.major_behavior_issue) ids.add(9);
  if (record && !record.previous_recommendations_respected) ids.add(15);
  if (computed.pendingPreviousDebts > 0) ids.add(7);
  if (computed.absences >= absenceThreshold) ids.add(22);
  if (computed.totalUeNotValidated >= 2) ids.add(14);

  if (computed.automaticOpinion === 'favorable') ids.add(2);
  // Une seule UE non validée n'entraîne pas automatiquement la préconisation #14,
  // dont le texte parle explicitement de plusieurs rattrapages.
  return [...ids];
}

export function computeJury(
  student: Student,
  yearLabel: string,
  evaluations: Evaluation[],
  ues: UE[],
  grades: Grade[],
  debts: Debt[],
  record: JuryRecord | null,
): JuryComputed {
  const semesters = yearToSemesters(yearLabel);
  const relevantEvals = evaluations.filter((e) => semesters.includes(e.semester) && e.active);
  const relevantUes = ues.filter((u) => semesters.includes(u.semester));
  const gradeMap = makeGradeMap(grades);
  const results = computeStudentUEs(student.id, relevantUes, relevantEvals, gradeMap);

  const semesterValidated: Record<number, boolean | null> = {};
  for (const semester of semesters) {
    const sResults = results.filter((r) => r.ue.semester === semester);
    semesterValidated[semester] = sResults.length
      ? sResults.every((r) => r.validated && !r.missing)
      : null;
  }

  const ectsAcquired = results.reduce((sum, r) => sum + (r.validated ? Number(r.ue.ects || 0) : 0), 0);
  const nonValidated = results.filter((r) => !r.validated && !r.missing);
  const academicUeNotValidated = nonValidated.filter((r) => !r.ue.is_enterprise).length;
  const totalUeNotValidated = nonValidated.length;
  const missingGrades = relevantEvals.reduce((sum, e) => {
    const g = gradeMap.get(`${student.id}:${e.id}`);
    return sum + (!g || (!g.final_mention && !g.absence) ? 1 : 0);
  }, 0);
  const absences = relevantEvals.reduce((sum, e) => {
    const g = gradeMap.get(`${student.id}:${e.id}`);
    return sum + (g?.absence === 'AJ' || g?.absence === 'ANJ' ? 1 : 0);
  }, 0);

  const currentYearNumber = Number(yearLabel.replace(/\D/g, '')) || 0;
  const studentDebts = debts.filter((d) => d.student_id === student.id);
  const previous = studentDebts.filter((d) => {
    const n = Number(d.origin_year_label.replace(/\D/g, '')) || Number(semesterToYear(d.origin_semester).replace(/\D/g, ''));
    return n < currentYearNumber;
  });
  const pendingPreviousDebts = previous.filter((d) => d.status === 'pending').length;
  const validatedPreviousDebts = previous.filter((d) => d.status === 'validated').length;

  const reasons: string[] = [];
  if (missingGrades) reasons.push(`${missingGrades} note(s) non saisie(s)`);
  if (academicUeNotValidated) reasons.push(`${academicUeNotValidated} UE académique(s) non validée(s)`);
  if (pendingPreviousDebts) reasons.push(`${pendingPreviousDebts} dette(s) antérieure(s) non validée(s)`);
  if (validatedPreviousDebts) reasons.push(`${validatedPreviousDebts} ex-dette(s)`);
  if (absences) reasons.push(`${absences} absence(s) AJ/ANJ`);
  if (record?.major_behavior_issue) reasons.push('Écart de comportement majeur');
  if (record && !record.previous_recommendations_respected) reasons.push('Préconisations précédentes non respectées');

  let automaticOpinion: JuryOpinion | null = null;
  const hasReferenceData = semesters.every((semester) => relevantUes.some((ue) => ue.semester === semester));
  if (hasReferenceData && missingGrades === 0) {
    const bothSemestersValidated = semesters.every((s) => semesterValidated[s] === true);
    if (
      ectsAcquired < 18 ||
      pendingPreviousDebts > 0 ||
      record?.major_behavior_issue ||
      (record && !record.previous_recommendations_respected)
    ) {
      automaticOpinion = 'defavorable';
    } else if (bothSemestersValidated) {
      automaticOpinion = 'favorable';
    } else if (academicUeNotValidated <= 3) {
      automaticOpinion = 'reserve';
    } else {
      automaticOpinion = 'defavorable';
    }
  }

  return {
    automaticOpinion,
    semesterValidated,
    ectsAcquired,
    academicUeNotValidated,
    totalUeNotValidated,
    pendingPreviousDebts,
    validatedPreviousDebts,
    absences,
    missingGrades,
    reasons,
  };
}

export function opinionLabel(value: JuryOpinion | null) {
  if (value === 'favorable') return 'Avis favorable';
  if (value === 'reserve') return 'Avis réservé';
  if (value === 'defavorable') return 'Avis défavorable';
  return 'Indéterminé';
}
