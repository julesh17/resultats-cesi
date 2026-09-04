import { NextRequest, NextResponse } from 'next/server';
import { parseNotesWorkbook, fuzzyScore, type NotesImportRow } from '@/lib/excel';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { requireApiUser } from '@/lib/server/auth';
import { syncDebtsForSession } from '@/lib/server/debts';
import { normalizeAnalyticCode, normalizeText, slugify } from '@/lib/utils';
import type { CycleType } from '@/lib/types';
import { publicServerError } from '@/lib/server/errors';

type SessionRow = {
  id: string;
  name: string;
  analytic_code: string | null;
  cycle: CycleType;
};

function chunks<T>(array: T[], size = 800) {
  const out: T[][] = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

function inferCycle(rows: NotesImportRow[]): CycleType {
  const semesters = rows.flatMap((row) => row.grades.map((grade) => grade.semester));
  if (semesters.length) return semesters.some((semester) => semester >= 5) ? 'ingenieur' : 'cpi';
  return normalizeText(rows[0]?.sessionName || '').includes('cpi') ? 'cpi' : 'ingenieur';
}

export async function POST(request: NextRequest) {
  const auth = await requireApiUser(request);
  if (!auth.user) return NextResponse.json({ error: auth.error }, { status: 401 });

  try {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return NextResponse.json({ error: 'Fichier Excel manquant.' }, { status: 400 });
    if (!file.name.toLowerCase().endsWith('.xlsx')) return NextResponse.json({ error: 'Le fichier doit être au format .xlsx.' }, { status: 400 });

    const buffer = await file.arrayBuffer();
    const parsedRows = parseNotesWorkbook(buffer);
    const expectedCells = parsedRows.reduce((sum, row) => sum + row.grades.length, 0);
    const filledResults = parsedRows.reduce(
      (sum, row) => sum + row.grades.filter((grade) => Boolean(grade.finalMention || grade.absence)).length,
      0,
    );
    const evaluationColumns = new Set(
      parsedRows.flatMap((row) => row.grades.map((grade) => `${normalizeText(row.sessionName)}:${grade.semester}:${grade.normalizedName}`)),
    ).size;
    const expectedUniqueCells = new Set(
      parsedRows.flatMap((row) => row.grades.map((grade) =>
        `${normalizeText(row.sessionName)}:${row.personKey}:${grade.semester}:${grade.normalizedName}`)),
    ).size;
    const admin = getSupabaseAdmin();

    // Un même import peut contenir plusieurs sessions. Les variantes de casse/accents
    // du nom sont regroupées afin d'éviter de créer des doublons artificiels.
    const groups = new Map<string, { name: string; rows: NotesImportRow[] }>();
    for (const row of parsedRows) {
      const key = normalizeText(row.sessionName);
      const existing = groups.get(key);
      if (existing) existing.rows.push(row);
      else groups.set(key, { name: row.sessionName, rows: [row] });
    }

    const { data: existingRows, error: sessionError } = await admin
      .from('sessions')
      .select('id,name,analytic_code,cycle');
    if (sessionError) throw new Error(`Lecture des sessions : ${sessionError.message}`);

    const knownSessions = [...((existingRows || []) as SessionRow[])];
    const resolvedGroups: Array<{ name: string; rows: NotesImportRow[]; session: SessionRow }> = [];
    let sessionsCreated = 0;
    let sessionsWithoutCode = 0;

    for (const group of groups.values()) {
      const providedCodes = [...new Set(
        group.rows
          .map((row) => row.sessionAnalyticCode ? normalizeAnalyticCode(row.sessionAnalyticCode) : '')
          .filter(Boolean),
      )];
      if (providedCodes.length > 1) {
        throw new Error(`Plusieurs codes analytiques différents sont indiqués pour la session « ${group.name} » : ${providedCodes.join(', ')}.`);
      }
      const providedCode = providedCodes[0] || '';

      const byName = knownSessions.find((session) => normalizeText(session.name) === normalizeText(group.name));
      const byCode = providedCode
        ? knownSessions.find((session) => session.analytic_code && normalizeAnalyticCode(session.analytic_code) === providedCode)
        : undefined;

      if (
        byName?.analytic_code &&
        providedCode &&
        normalizeAnalyticCode(byName.analytic_code) !== providedCode
      ) {
        throw new Error(
          `La session « ${group.name} » existe déjà avec le code analytique « ${byName.analytic_code} », alors que le fichier indique « ${providedCode} ».`,
        );
      }

      let session = byName || byCode;

      if (!session) {
        const insert = await admin.from('sessions').insert({
          name: group.name.trim(),
          analytic_code: providedCode || null,
          cycle: inferCycle(group.rows),
          created_by: auth.user.id,
        }).select('id,name,analytic_code,cycle').single();

        if (insert.error || !insert.data) {
          throw new Error(`Création automatique de la session « ${group.name} » : ${insert.error?.message || 'échec inconnu'}`);
        }
        session = insert.data as SessionRow;
        knownSessions.push(session);
        sessionsCreated += 1;

        // L'utilisateur qui réalise l'import suit automatiquement la session créée.
        const follow = await admin.from('session_subscriptions').upsert({
          user_id: auth.user.id,
          session_id: session.id,
        });
        if (follow.error) throw new Error(`Abonnement à la session « ${group.name} » : ${follow.error.message}`);
      } else if (!session.analytic_code && providedCode) {
        const update = await admin
          .from('sessions')
          .update({ analytic_code: providedCode })
          .eq('id', session.id)
          .select('id,name,analytic_code,cycle')
          .single();
        if (update.error || !update.data) throw new Error(`Mise à jour du code analytique : ${update.error?.message || 'échec inconnu'}`);
        session = update.data as SessionRow;
        const index = knownSessions.findIndex((candidate) => candidate.id === session!.id);
        if (index >= 0) knownSessions[index] = session;
      }

      if (!session.analytic_code) sessionsWithoutCode += 1;
      resolvedGroups.push({ ...group, session });
    }

    const safeName = `${Date.now()}-${slugify(file.name.replace(/\.xlsx$/i, '')) || 'notes'}.xlsx`;
    const storagePath = `notes/${safeName}`;
    const upload = await admin.storage.from('imports').upload(storagePath, buffer, {
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      upsert: false,
    });
    if (upload.error) throw new Error(`Stockage du fichier : ${upload.error.message}`);

    const sessionNames = resolvedGroups.map((group) => group.session.name);
    const historyInsert = await admin.from('import_history').insert({
      kind: 'notes',
      file_name: file.name,
      storage_path: storagePath,
      session_id: null,
      imported_by: auth.user.id,
      rows_count: parsedRows.length,
      metadata: {
        sessions: sessionNames,
        sessions_created: sessionsCreated,
        sessions_without_analytic_code: sessionsWithoutCode,
      },
    }).select('id').single();
    if (historyInsert.error) throw new Error(historyInsert.error.message);
    const importId = historyInsert.data.id;

    let studentCount = 0;
    let evaluationCount = 0;
    let gradeCount = 0;
    const touchedSessionIds = new Set<string>();

    for (const group of resolvedGroups) {
      const { session, rows } = group;
      const sessionName = session.name;
      touchedSessionIds.add(session.id);

      // Un fichier peut exceptionnellement contenir plusieurs lignes pour la même personne.
      // PostgreSQL refuse un UPSERT si la même clé de conflit apparaît deux fois dans une
      // seule commande ; on déduplique donc avant l'envoi à Supabase.
      const studentPayloadByKey = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        studentPayloadByKey.set(row.personKey, {
          session_id: session.id,
          person_key: row.personKey,
          first_name: row.firstName,
          last_name: row.lastName,
          option_name: row.optionName,
        });
      }
      const studentPayload = [...studentPayloadByKey.values()];
      const { data: importedStudents, error: studentError } = await admin
        .from('students')
        .upsert(studentPayload, { onConflict: 'session_id,person_key' })
        .select('*');
      if (studentError) throw new Error(`Étudiants (${sessionName}) : ${studentError.message}`);
      studentCount += importedStudents?.length || 0;
      const studentByKey = new Map(((importedStudents || []) as Array<{ id: string; person_key: string }>).map((student) => [student.person_key, student]));

      const { data: existingEvals, error: evalReadError } = await admin
        .from('evaluations')
        .select('*')
        .eq('session_id', session.id);
      if (evalReadError) throw new Error(evalReadError.message);
      const localEvals = [...((existingEvals || []) as Array<any>)];

      const gradeDescriptors = rows.flatMap((row) => row.grades);
      const uniqueIncoming = new Map<string, (typeof gradeDescriptors)[number]>();
      gradeDescriptors.forEach((grade) => uniqueIncoming.set(`${grade.semester}:${grade.normalizedName}`, grade));

      // Résolution stable « colonne Excel -> évaluation DB ». Une correspondance floue ne
      // peut être utilisée que par une seule colonne entrante. Sans cela, deux colonnes
      // proches peuvent pointer vers la même evaluation_id et produire deux lignes avec la
      // même clé (student_id, evaluation_id) dans le même UPSERT.
      const evaluationByIncomingKey = new Map<string, any>();
      const claimedFuzzyEvaluationIds = new Set<string>();

      for (const [incomingKey, incoming] of uniqueIncoming.entries()) {
        let match = localEvals.find(
          (evaluation) => evaluation.semester === incoming.semester && evaluation.normalized_name === incoming.normalizedName,
        );

        if (!match) {
          const candidates = localEvals
            .filter(
              (evaluation) =>
                evaluation.semester === incoming.semester &&
                !claimedFuzzyEvaluationIds.has(evaluation.id),
            )
            .map((evaluation) => ({ evaluation, score: fuzzyScore(evaluation.name, incoming.evaluationName) }))
            .sort((a, b) => b.score - a.score);
          if (candidates[0]?.score >= 60) {
            match = candidates[0].evaluation;
            claimedFuzzyEvaluationIds.add(match.id);
          }
        }

        if (match) {
          if (!match.active) {
            const reactivation = await admin
              .from('evaluations')
              .update({ active: true, source_name: incoming.evaluationName })
              .eq('id', match.id);
            if (reactivation.error) throw new Error(`Réactivation de l’évaluation : ${reactivation.error.message}`);
            match.active = true;
          }
          evaluationByIncomingKey.set(incomingKey, match);
        } else {
          const inserted = await admin.from('evaluations').insert({
            session_id: session.id,
            semester: incoming.semester,
            name: incoming.evaluationName,
            normalized_name: incoming.normalizedName,
            source_name: incoming.evaluationName,
            coefficient: 1,
            active: true,
          }).select('*').single();
          if (inserted.error) throw new Error(`Évaluation : ${inserted.error.message}`);
          localEvals.push(inserted.data);
          evaluationByIncomingKey.set(incomingKey, inserted.data);
          evaluationCount += 1;
        }
      }

      // Dernière protection : une seule ligne par clé de conflit. Cela rend aussi l'import
      // idempotent si le fichier contient accidentellement des doublons de lignes.
      const gradesPayloadByKey = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        const student = studentByKey.get(row.personKey);
        if (!student) continue;
        for (const grade of row.grades) {
          const incomingKey = `${grade.semester}:${grade.normalizedName}`;
          const evaluation = evaluationByIncomingKey.get(incomingKey);
          if (!evaluation) continue;
          gradesPayloadByKey.set(`${student.id}:${evaluation.id}`, {
            student_id: student.id,
            evaluation_id: evaluation.id,
            raw_mention: grade.rawMention,
            initial_mention: grade.initialMention,
            final_mention: grade.finalMention,
            numeric_note_text: grade.numericNoteText,
            absence: grade.absence,
            import_id: importId,
            manual_override: false,
            updated_by: auth.user.id,
          });
        }
      }
      const gradesPayload = [...gradesPayloadByKey.values()];

      for (const batch of chunks(gradesPayload)) {
        const upsert = await admin.from('grades').upsert(batch, { onConflict: 'student_id,evaluation_id' });
        if (upsert.error) throw new Error(`Notes (${sessionName}) : ${upsert.error.message}`);
        gradeCount += batch.length;
      }
    }

    if (gradeCount !== expectedUniqueCells) {
      throw new Error(
        `Import incomplet : ${expectedUniqueCells} cellules distinctes étaient attendues mais ${gradeCount} seulement ont été préparées.`,
      );
    }

    const verification = await admin
      .from('grades')
      .select('id', { count: 'exact', head: true })
      .eq('import_id', importId);
    if (verification.error) throw new Error(`Vérification de l’import : ${verification.error.message}`);
    const verifiedGradeCount = verification.count || 0;
    if (verifiedGradeCount !== gradeCount) {
      throw new Error(`Vérification de l’import : ${gradeCount} cellules ont été envoyées mais ${verifiedGradeCount} seulement sont présentes en base.`);
    }

    const historyUpdate = await admin.from('import_history').update({
      metadata: {
        sessions: sessionNames,
        sessions_created: sessionsCreated,
        sessions_without_analytic_code: sessionsWithoutCode,
        evaluation_columns: evaluationColumns,
        expected_cells: expectedCells,
        expected_unique_cells: expectedUniqueCells,
        filled_results: filledResults,
        stored_cells: verifiedGradeCount,
      },
    }).eq('id', importId);
    if (historyUpdate.error) throw new Error(`Historique de l’import : ${historyUpdate.error.message}`);

    const debtSync: Array<{ detected: number; inserted: number }> = [];
    for (const sessionId of touchedSessionIds) {
      debtSync.push(await syncDebtsForSession(sessionId, auth.user.id));
    }

    return NextResponse.json({
      ok: true,
      sessions: resolvedGroups.length,
      sessions_created: sessionsCreated,
      sessions_without_analytic_code: sessionsWithoutCode,
      students: studentCount,
      evaluations_created: evaluationCount,
      grades: gradeCount,
      grades_verified: verifiedGradeCount,
      evaluation_columns: evaluationColumns,
      expected_cells: expectedCells,
      expected_unique_cells: expectedUniqueCells,
      filled_results: filledResults,
      debts_detected: debtSync.reduce((sum, item) => sum + item.detected, 0),
      debts_created: debtSync.reduce((sum, item) => sum + item.inserted, 0),
    });
  } catch (error) {
    return NextResponse.json({ error: publicServerError(error, 'Import impossible.') }, { status: 500 });
  }
}
