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
import { normalizeText, semesterToYear, yearToSemesters } from './utils';

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

function hasResult(grade: Grade | null | undefined) {
  return Boolean(grade?.final_mention || grade?.absence);
}

/**
 * Une cellule vide est interprétée comme une absence seulement lorsque tous les
 * autres étudiants actifs ont déjà un résultat sur cette même évaluation.
 * Ainsi, une évaluation future ou encore en cours ne transforme pas les blancs
 * en absences.
 */
export function makeInferredBlankAbsenceSet(
  students: Student[],
  evaluations: Evaluation[],
  grades: Grade[],
) {
  const activeStudents = students.filter((student) => student.active !== false);
  const gradeMap = makeGradeMap(grades);
  const inferred = new Set<string>();

  if (activeStudents.length < 2) return inferred;

  for (const evaluation of evaluations.filter((item) => item.active)) {
    for (const student of activeStudents) {
      const ownKey = `${student.id}:${evaluation.id}`;
      if (hasResult(gradeMap.get(ownKey))) continue;

      const allOthersHaveResult = activeStudents.every((other) => {
        if (other.id === student.id) return true;
        return hasResult(gradeMap.get(`${other.id}:${evaluation.id}`));
      });
      if (allOthersHaveResult) inferred.add(ownKey);
    }
  }
  return inferred;
}

export function gradeValue(grade: Grade | null | undefined, inferredBlankAbsence = false): number | null {
  if (inferredBlankAbsence) return GRADE_VALUES.D;
  if (!grade) return null;
  if (grade.final_mention && GRADE_VALUES[grade.final_mention] !== undefined) return GRADE_VALUES[grade.final_mention];
  if (grade.absence === 'AJ' || grade.absence === 'ANJ') return GRADE_VALUES.D;
  return null;
}

export function gradeNeedsRetake(grade: Grade | null | undefined, inferredBlankAbsence = false) {
  if (inferredBlankAbsence) return true;
  if (!grade) return false;
  if (grade.absence === 'AJ' || grade.absence === 'ANJ') return true;
  return grade.final_mention === 'C' || grade.final_mention === 'D';
}

export function gradeHadResit(grade: Grade | null | undefined) {
  return Boolean(grade?.raw_mention?.includes('/'));
}


function extractToeicScores(raw: string | null | undefined): number[] {
  if (!raw) return [];
  const text = String(raw).trim().replace(/,/g, '.');
  if (!text) return [];

  const scores: number[] = [];
  for (const attempt of text.split('#')) {
    const clean = attempt.trim();
    if (!clean) continue;

    // Formats courants du fichier CESI : « 575 / 990 », « 230 # 495 » ou « 625 ».
    const outOf990 = clean.match(/(\d+(?:\.\d+)?)\s*\/\s*990\b/i);
    if (outOf990) {
      const value = Number(outOf990[1]);
      if (Number.isFinite(value) && value >= 0 && value <= 990) scores.push(value);
      continue;
    }

    const values = (clean.match(/\d+(?:\.\d+)?/g) || [])
      .map(Number)
      .filter((value) => Number.isFinite(value) && value >= 0 && value <= 990);
    if (values.length) scores.push(values[values.length - 1]);
  }
  return scores;
}

function isToeicEvaluation(evaluation: Evaluation) {
  const name = normalizeText(evaluation.name);
  return name.includes('anglais')
    && name.includes('preparation a la certification')
    && name.includes('global exam');
}

export function gradeTooltip(grade: Grade | null | undefined): string {
  if (!grade) return '';
  const lines: string[] = [];
  if (grade.numeric_note_text) lines.push(`Note numérique : ${grade.numeric_note_text}`);
  if (grade.raw_mention?.includes('/')) lines.push(`Rattrapage : ${grade.raw_mention}`);
  if (grade.absence) lines.push(`Absence : ${grade.absence}`);
  return lines.join(' · ');
}

export function makeGradeMap(grades: Grade[]) {
  return new Map<string, Grade>(grades.map((g) => [`${g.student_id}:${g.evaluation_id}`, g]));
}

export function computeStudentUE(
  studentId: string,
  ue: UE,
  evaluations: Evaluation[],
  gradeMap: Map<string, Grade>,
  inferredBlankAbsences: Set<string> = new Set<string>(),
): UEComputedResult {
  const elements = evaluations
    .filter((e) => e.ue_id === ue.id && e.active)
    .map((evaluation) => {
      const key = `${studentId}:${evaluation.id}`;
      const grade = gradeMap.get(key) || null;
      const inferredAbsence = inferredBlankAbsences.has(key);
      return { evaluation, grade, value: gradeValue(grade, inferredAbsence), inferredAbsence };
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
    return f === 'C' || f === 'D' || e.grade?.absence === 'AJ' || e.grade?.absence === 'ANJ' || e.inferredAbsence;
  });

  return { ue, mention, weightedAverage: avg, validated, compensation, missing, elements };
}

export function computeStudentUEs(
  studentId: string,
  ues: UE[],
  evaluations: Evaluation[],
  gradeMap: Map<string, Grade>,
  inferredBlankAbsences: Set<string> = new Set<string>(),
) {
  return ues.map((ue) => computeStudentUE(studentId, ue, evaluations, gradeMap, inferredBlankAbsences));
}

export function isEvaluationCompensated(
  studentId: string,
  evaluation: Evaluation,
  ues: UE[],
  evaluations: Evaluation[],
  gradeMap: Map<string, Grade>,
  inferredBlankAbsences: Set<string> = new Set<string>(),
) {
  if (!evaluation.ue_id) return false;
  const ue = ues.find((x) => x.id === evaluation.ue_id);
  if (!ue) return false;
  const result = computeStudentUE(studentId, ue, evaluations, gradeMap, inferredBlankAbsences);
  return result.validated && result.compensation && !result.missing;
}

export function buildRetakeMap(
  students: Student[],
  evaluations: Evaluation[],
  grades: Grade[],
  ues: UE[],
) {
  const gradeMap = makeGradeMap(grades);
  const inferredBlankAbsences = makeInferredBlankAbsenceSet(students, evaluations, grades);
  const current = new Map<string, Student[]>();
  const failedAfterResit = new Map<string, Student[]>();

  for (const evaluation of evaluations.filter((e) => e.active)) {
    for (const student of students.filter((s) => s.active)) {
      const key = `${student.id}:${evaluation.id}`;
      const grade = gradeMap.get(key);
      const inferredAbsence = inferredBlankAbsences.has(key);
      if (!gradeNeedsRetake(grade, inferredAbsence)) continue;
      if (isEvaluationCompensated(student.id, evaluation, ues, evaluations, gradeMap, inferredBlankAbsences)) continue;
      const target = gradeHadResit(grade) ? failedAfterResit : current;
      const list = target.get(evaluation.id) || [];
      list.push(student);
      target.set(evaluation.id, list);
    }
  }
  return { current, failedAfterResit, inferredBlankAbsences };
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
  _hasPreviousJury = false,
): number[] {
  const ids = new Set<number>();
  if (record?.major_behavior_issue) ids.add(9);
  if (record && !record.previous_recommendations_respected) ids.add(15);
  if (computed.pendingPreviousDebts > 0) ids.add(7);
  if (computed.unjustifiedAbsences > 0) ids.add(22);
  if (computed.totalUeNotValidated >= 2) ids.add(14);
  if (computed.automaticOpinion === 'favorable') {
    if (computed.resitCount === 0) ids.add(1);
    else ids.add(2);
  }
  if (computed.toeicScore !== null && computed.toeicScore < 785) {
    ids.add(25);
    if (computed.toeicProgressed) ids.add(26);
  }
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
  cohortStudents: Student[] = [student],
): JuryComputed {
  const semesters = yearToSemesters(yearLabel);
  const relevantUes = ues.filter((u) => semesters.includes(u.semester) && u.active !== false && !u.exclude_from_jury);
  const relevantUeIds = new Set(relevantUes.map((u) => u.id));
  const yearEvals = evaluations.filter((e) => semesters.includes(e.semester) && e.active);
  const relevantEvals = yearEvals.filter((e) => Boolean(e.ue_id && relevantUeIds.has(e.ue_id)));
  const gradeMap = makeGradeMap(grades);
  const inferredBlankAbsences = makeInferredBlankAbsenceSet(cohortStudents, relevantEvals, grades);
  const results = computeStudentUEs(student.id, relevantUes, relevantEvals, gradeMap, inferredBlankAbsences);
  const finalizedResults = results.filter((r) => !r.missing);

  const semesterValidated: Record<number, boolean | null> = {};
  const semesterComplete: Record<number, boolean> = {};
  for (const semester of semesters) {
    const allSemesterResults = results.filter((r) => r.ue.semester === semester);
    const finalizedSemesterResults = allSemesterResults.filter((r) => !r.missing);
    const complete = allSemesterResults.length > 0 && finalizedSemesterResults.length === allSemesterResults.length;
    semesterComplete[semester] = complete;
    if (!finalizedSemesterResults.length) semesterValidated[semester] = null;
    else if (finalizedSemesterResults.some((r) => !r.validated)) semesterValidated[semester] = false;
    else semesterValidated[semester] = complete ? true : null;
  }

  const yearComplete = semesters.every((semester) => semesterComplete[semester]);
  const ectsAcquired = finalizedResults.reduce((sum, r) => sum + (r.validated ? Number(r.ue.ects || 0) : 0), 0);
  const nonValidated = finalizedResults.filter((r) => !r.validated);
  const academicUeNotValidated = nonValidated.filter((r) => !r.ue.is_enterprise).length;
  const totalUeNotValidated = nonValidated.length;

  const blankAbsences = relevantEvals.reduce((sum, e) => sum + (inferredBlankAbsences.has(`${student.id}:${e.id}`) ? 1 : 0), 0);
  const missingGrades = relevantEvals.reduce((sum, e) => {
    const key = `${student.id}:${e.id}`;
    const g = gradeMap.get(key);
    return sum + (!hasResult(g) && !inferredBlankAbsences.has(key) ? 1 : 0);
  }, 0);
  const justifiedAbsences = relevantEvals.reduce((sum, e) => {
    const g = gradeMap.get(`${student.id}:${e.id}`);
    return sum + (g?.absence === 'AJ' ? 1 : 0);
  }, 0);
  const unjustifiedAbsences = relevantEvals.reduce((sum, e) => {
    const g = gradeMap.get(`${student.id}:${e.id}`);
    return sum + (g?.absence === 'ANJ' ? 1 : 0);
  }, 0);
  const absences = blankAbsences + justifiedAbsences + unjustifiedAbsences;
  const resitCount = yearEvals.reduce((sum, e) => {
    const grade = gradeMap.get(`${student.id}:${e.id}`);
    return sum + (gradeHadResit(grade) ? 1 : 0);
  }, 0);
  const resitValidatedCount = yearEvals.reduce((sum, e) => {
    const grade = gradeMap.get(`${student.id}:${e.id}`);
    return sum + (gradeHadResit(grade) && (grade?.final_mention === 'A' || grade?.final_mention === 'B') ? 1 : 0);
  }, 0);

  const toeicScores = yearEvals
    .filter(isToeicEvaluation)
    .sort((a, b) => a.semester - b.semester || a.name.localeCompare(b.name))
    .flatMap((evaluation) => extractToeicScores(gradeMap.get(`${student.id}:${evaluation.id}`)?.numeric_note_text));
  const toeicScore = toeicScores.length ? toeicScores[toeicScores.length - 1] : null;
  const toeicPreviousScore = toeicScores.length > 1 ? toeicScores[toeicScores.length - 2] : null;
  const toeicProgressed = toeicScore !== null && toeicPreviousScore !== null && toeicScore > toeicPreviousScore;

  const currentYearNumber = Number(yearLabel.replace(/\D/g, '')) || 0;
  const studentDebts = debts.filter((d) => d.student_id === student.id);
  const previous = studentDebts.filter((d) => {
    const n = Number(d.origin_year_label.replace(/\D/g, '')) || Number(semesterToYear(d.origin_semester).replace(/\D/g, ''));
    return n < currentYearNumber;
  });
  const pendingPreviousDebts = previous.filter((d) => d.status === 'pending').length;
  const validatedPreviousDebts = previous.filter((d) => d.status === 'validated').length;

  const reasons: string[] = [];
  if (academicUeNotValidated) reasons.push(`${academicUeNotValidated} UE académique(s) non validée(s)`);
  if (pendingPreviousDebts) reasons.push(`${pendingPreviousDebts} dette(s) antérieure(s) non validée(s)`);
  if (validatedPreviousDebts) reasons.push(`${validatedPreviousDebts} ex-dette(s)`);
  if (blankAbsences) reasons.push(`${blankAbsences} absence(s)`);
  if (justifiedAbsences) reasons.push(`${justifiedAbsences} AJ`);
  if (unjustifiedAbsences) reasons.push(`${unjustifiedAbsences} ANJ`);
  if (record?.major_behavior_issue) reasons.push('Écart de comportement majeur');
  if (record && !record.previous_recommendations_respected) reasons.push('Préconisations précédentes non respectées');

  let automaticOpinion: Exclude<JuryOpinion, 'indetermine'> | null = null;
  let automaticOpinionReason = 'Avis indéterminé : les résultats disponibles ne permettent pas encore de statuer automatiquement.';
  const hasReferenceData = relevantUes.length > 0;
  if (!hasReferenceData) {
    automaticOpinionReason = 'Avis indéterminé : aucune UE du référentiel n’est disponible pour cette année.';
  } else {
    const bothSemestersValidated = semesters.every((s) => semesterValidated[s] === true);
    const blockingReasons: string[] = [];
    if (pendingPreviousDebts > 0) blockingReasons.push(`${pendingPreviousDebts} dette(s) d’une année précédente encore non validée(s)`);
    if (record?.major_behavior_issue) blockingReasons.push('un écart de comportement majeur est signalé');
    if (record && !record.previous_recommendations_respected) blockingReasons.push('les préconisations du jury précédent ne sont pas respectées');

    if (blockingReasons.length) {
      automaticOpinion = 'defavorable';
      automaticOpinionReason = `Avis défavorable : ${blockingReasons.join(' ; ')}.`;
    } else if (yearComplete && ectsAcquired < 18) {
      automaticOpinion = 'defavorable';
      automaticOpinionReason = `Avis défavorable : l’année est complète mais seulement ${ectsAcquired} ECTS sont acquis, soit moins de 18 ECTS.`;
    } else if (bothSemestersValidated) {
      automaticOpinion = 'favorable';
      automaticOpinionReason = `Avis favorable : les semestres S${semesters[0]} et S${semesters[1]} sont complets et validés.`;
    } else if (academicUeNotValidated > 3) {
      automaticOpinion = 'defavorable';
      automaticOpinionReason = `Avis défavorable : ${academicUeNotValidated} UE académiques finalisées ne sont pas validées, soit plus de 3.`;
    } else if (academicUeNotValidated > 0 || totalUeNotValidated > 0) {
      automaticOpinion = 'reserve';
      automaticOpinionReason = `Avis réservé : ${totalUeNotValidated} UE finalisée(s) ne sont pas validée(s), dont ${academicUeNotValidated} UE académique(s).`;
    } else if (!yearComplete) {
      automaticOpinionReason = 'Avis indéterminé : aucune UE finalisée n’est en échec, mais l’année n’est pas encore suffisamment complète pour valider automatiquement les deux semestres.';
    }
  }

  return {
    automaticOpinion,
    semesterValidated,
    semesterComplete,
    yearComplete,
    finalizedUeCount: finalizedResults.length,
    ectsAcquired,
    academicUeNotValidated,
    totalUeNotValidated,
    pendingPreviousDebts,
    validatedPreviousDebts,
    absences,
    blankAbsences,
    justifiedAbsences,
    unjustifiedAbsences,
    missingGrades,
    resitCount,
    resitValidatedCount,
    toeicScore,
    toeicPreviousScore,
    toeicProgressed,
    automaticOpinionReason,
    reasons,
  };
}

export function opinionLabel(value: JuryOpinion | null) {
  if (value === 'favorable') return 'Avis favorable';
  if (value === 'reserve') return 'Avis réservé';
  if (value === 'defavorable') return 'Avis défavorable';
  return 'Indéterminé';
}
