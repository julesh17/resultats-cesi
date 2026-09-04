import 'server-only';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { computeStudentUE, gradeHadResit, gradeNeedsRetake, makeGradeMap, makeInferredBlankAbsenceSet } from '@/lib/results';
import { semesterToYear } from '@/lib/utils';
import type { Evaluation, Grade, Student, UE } from '@/lib/types';

export async function syncDebtsForSession(sessionId: string, userId?: string) {
  const admin = getSupabaseAdmin();
  const [{ data: students, error: sError }, { data: ues, error: uError }, { data: evaluations, error: eError }] = await Promise.all([
    admin.from('students').select('*').eq('session_id', sessionId).eq('active', true),
    admin.from('ues').select('*').eq('session_id', sessionId).eq('active', true),
    admin.from('evaluations').select('*').eq('session_id', sessionId).eq('active', true),
  ]);
  if (sError || uError || eError) throw new Error(sError?.message || uError?.message || eError?.message || 'Erreur de lecture.');

  const evalIds = (evaluations || []).map((e) => e.id);
  let grades: Grade[] = [];
  if (evalIds.length) {
    const { data, error } = await admin.from('grades').select('*').in('evaluation_id', evalIds);
    if (error) throw new Error(error.message);
    grades = (data || []) as Grade[];
  }

  const typedStudents = (students || []) as Student[];
  const typedUes = (ues || []) as UE[];
  const typedEvaluations = (evaluations || []) as Evaluation[];
  const gradeMap = makeGradeMap(grades);
  const inferredBlankAbsences = makeInferredBlankAbsenceSet(typedStudents, typedEvaluations, grades);
  const candidates: Array<{
    student_id: string;
    ue_id: string;
    origin_year_label: string;
    origin_semester: number;
    status: 'pending';
    created_by?: string;
  }> = [];

  for (const student of typedStudents) {
    for (const ue of typedUes) {
      const result = computeStudentUE(student.id, ue, typedEvaluations, gradeMap, inferredBlankAbsences);

      // Une dette n'est créée que lorsque l'UE est réellement finalisée, qu'elle reste
      // non validée, et qu'il n'existe plus de C/D à rattraper sans résultat de rattrapage.
      // Exemple : C/C + B + B dans une UE finale C => dette.
      if (result.missing || result.validated || result.weightedAverage === null) continue;
      const gradesStillFailing = result.elements.filter((element) => gradeNeedsRetake(element.grade, element.inferredAbsence));
      if (!gradesStillFailing.length) continue;
      const atLeastOneResit = result.elements.some((element) => gradeHadResit(element.grade));
      const allFailingGradesHaveResit = gradesStillFailing.every((element) => gradeHadResit(element.grade));
      if (!atLeastOneResit || !allFailingGradesHaveResit) continue;

      candidates.push({
        student_id: student.id,
        ue_id: ue.id,
        origin_year_label: semesterToYear(ue.semester),
        origin_semester: ue.semester,
        status: 'pending',
        ...(userId ? { created_by: userId } : {}),
      });
    }
  }

  if (!candidates.length) return { detected: 0, inserted: 0 };

  const studentIds = typedStudents.map((s) => s.id);
  let existingRows: Array<{ student_id: string; ue_id: string; origin_semester: number }> = [];
  if (studentIds.length) {
    const existing = await admin.from('debts').select('student_id,ue_id,origin_semester').in('student_id', studentIds);
    if (existing.error) throw new Error(existing.error.message);
    existingRows = existing.data || [];
  }

  const existingKeys = new Set(existingRows.map((d) => `${d.student_id}:${d.ue_id}:${d.origin_semester}`));
  const missing = candidates.filter((d) => !existingKeys.has(`${d.student_id}:${d.ue_id}:${d.origin_semester}`));
  if (missing.length) {
    const { error } = await admin.from('debts').insert(missing);
    if (error) throw new Error(error.message);
  }
  return { detected: candidates.length, inserted: missing.length };
}
