import { NextRequest, NextResponse } from 'next/server';
import { parseNotesWorkbook, type NotesImportRow } from '@/lib/excel';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { requireApiUser } from '@/lib/server/auth';
import { syncDebtsForSession } from '@/lib/server/debts';
import { normalizeAnalyticCode, normalizeText, slugify } from '@/lib/utils';
import type { CycleType, Evaluation } from '@/lib/types';
import { publicServerError } from '@/lib/server/errors';

type SessionRow = {
  id: string;
  name: string;
  analytic_code: string | null;
  cycle: CycleType;
};

type ImportedStudent = { id: string; person_key: string; active: boolean };

function chunks<T>(array: T[], size = 700) {
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
      parsedRows.flatMap((row) => row.grades.map((grade) => `${normalizeText(row.sessionName)}:${grade.sourceKey}`)),
    ).size;
    const expectedUniqueCells = new Set(
      parsedRows.flatMap((row) => row.grades.map((grade) =>
        `${normalizeText(row.sessionName)}:${row.personKey}:${grade.sourceKey}`)),
    ).size;

    if (expectedUniqueCells !== expectedCells) {
      throw new Error(`Le fichier contient des doublons de lignes ou de colonnes : ${expectedCells} cellules lues pour ${expectedUniqueCells} cellules distinctes.`);
    }

    const admin = getSupabaseAdmin();

    // Un fichier peut contenir plusieurs sessions. Le nom sert uniquement à grouper
    // les lignes du fichier ; le code analytique, lorsqu'il existe, reste insensible à la casse.
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

      if (byName?.analytic_code && providedCode && normalizeAnalyticCode(byName.analytic_code) !== providedCode) {
        throw new Error(`La session « ${group.name} » existe déjà avec un autre code analytique.`);
      }

      let session = byName || byCode;
      if (!session) {
        const insert = await admin.from('sessions').insert({
          name: group.name.trim(),
          analytic_code: providedCode || null,
          cycle: inferCycle(group.rows),
          created_by: auth.user.id,
        }).select('id,name,analytic_code,cycle').single();
        if (insert.error || !insert.data) throw new Error(`Création automatique de la session « ${group.name} » : ${insert.error?.message || 'échec inconnu'}`);
        session = insert.data as SessionRow;
        knownSessions.push(session);
        sessionsCreated += 1;
        const follow = await admin.from('session_subscriptions').upsert({ user_id: auth.user.id, session_id: session.id });
        if (follow.error) throw new Error(`Abonnement à la session « ${group.name} » : ${follow.error.message}`);
      } else if (!session.analytic_code && providedCode) {
        const update = await admin.from('sessions').update({ analytic_code: providedCode }).eq('id', session.id).select('id,name,analytic_code,cycle').single();
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
      kind: 'notes', file_name: file.name, storage_path: storagePath, session_id: null,
      imported_by: auth.user.id, rows_count: parsedRows.length,
      metadata: { sessions: sessionNames, sessions_created: sessionsCreated, sessions_without_analytic_code: sessionsWithoutCode },
    }).select('id').single();
    if (historyInsert.error) throw new Error(historyInsert.error.message);
    const importId = historyInsert.data.id;

    let studentCount = 0;
    let evaluationCount = 0;
    let gradeCount = 0;
    const touchedSessionIds = new Set<string>();

    for (const group of resolvedGroups) {
      const { session, rows } = group;
      touchedSessionIds.add(session.id);

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
      const studentUpsert = await admin.from('students')
        .upsert(studentPayload, { onConflict: 'session_id,person_key' })
        .select('id,person_key,active');
      if (studentUpsert.error) throw new Error(`Étudiants (${session.name}) : ${studentUpsert.error.message}`);
      const importedStudents = (studentUpsert.data || []) as ImportedStudent[];
      studentCount += importedStudents.length;
      if (importedStudents.length !== studentPayload.length) {
        throw new Error(`Étudiants (${session.name}) : ${studentPayload.length} lignes attendues, ${importedStudents.length} seulement retournées.`);
      }
      const studentByKey = new Map(importedStudents.map((student) => [student.person_key, student]));

      const existing = await admin.from('evaluations').select('*').eq('session_id', session.id);
      if (existing.error) throw new Error(`Matières (${session.name}) : ${existing.error.message}`);
      const localEvals = [...((existing.data || []) as Evaluation[])];

      // Une colonne Excel est une matière distincte. Son identité est source_key,
      // jamais une correspondance floue. C'est le point essentiel de la v7.
      const uniqueIncoming = new Map<string, NotesImportRow['grades'][number]>();
      for (const row of rows) for (const grade of row.grades) uniqueIncoming.set(grade.sourceKey, grade);
      const evaluationBySourceKey = new Map<string, Evaluation>();

      for (const incoming of uniqueIncoming.values()) {
        let match = localEvals.find((evaluation) => evaluation.source_key === incoming.sourceKey);

        // Si le référentiel a été importé avant les notes, son élément peut exister
        // sans source_key. On ne l'adopte qu'en cas de correspondance exacte de nom
        // normalisé et de semestre. Jamais de fuzzy matching pendant l'import des notes.
        if (!match) {
          const exactWithoutSource = localEvals.filter((evaluation) =>
            evaluation.semester === incoming.semester &&
            evaluation.normalized_name === incoming.normalizedName &&
            !evaluation.source_key,
          );
          if (exactWithoutSource.length > 1) {
            throw new Error(`Plusieurs matières du référentiel correspondent exactement à « ${incoming.evaluationName} » en S${incoming.semester}.`);
          }
          if (exactWithoutSource.length === 1) {
            const adopted = exactWithoutSource[0];
            const update = await admin.from('evaluations').update({
              source_key: incoming.sourceKey,
              source_name: incoming.evaluationName,
              name: incoming.evaluationName,
              normalized_name: incoming.normalizedName,
              active: true,
            }).eq('id', adopted.id).select('*').single();
            if (update.error || !update.data) throw new Error(`Matière « ${incoming.evaluationName} » : ${update.error?.message || 'mise à jour impossible'}`);
            match = update.data as Evaluation;
            const idx = localEvals.findIndex((e) => e.id === match!.id);
            if (idx >= 0) localEvals[idx] = match;
          }
        }

        if (!match) {
          const inserted = await admin.from('evaluations').insert({
            session_id: session.id,
            semester: incoming.semester,
            name: incoming.evaluationName,
            normalized_name: incoming.normalizedName,
            source_key: incoming.sourceKey,
            source_name: incoming.evaluationName,
            coefficient: 1,
            active: true,
          }).select('*').single();
          if (inserted.error || !inserted.data) throw new Error(`Matière « ${incoming.evaluationName} » : ${inserted.error?.message || 'création impossible'}`);
          match = inserted.data as Evaluation;
          localEvals.push(match);
          evaluationCount += 1;
        } else if (!match.active) {
          const reactivation = await admin.from('evaluations').update({ active: true }).eq('id', match.id);
          if (reactivation.error) throw new Error(`Réactivation de « ${incoming.evaluationName} » : ${reactivation.error.message}`);
          match = { ...match, active: true };
        }

        evaluationBySourceKey.set(incoming.sourceKey, match);
      }

      if (evaluationBySourceKey.size !== uniqueIncoming.size) {
        throw new Error(`Matières (${session.name}) : ${uniqueIncoming.size} colonnes attendues, ${evaluationBySourceKey.size} seulement préparées.`);
      }

      const gradesPayload: Record<string, unknown>[] = [];
      const conflictKeys = new Set<string>();
      for (const row of rows) {
        const student = studentByKey.get(row.personKey);
        if (!student) throw new Error(`Étudiant introuvable après import : ${row.personRaw}.`);
        for (const grade of row.grades) {
          const evaluation = evaluationBySourceKey.get(grade.sourceKey);
          if (!evaluation) throw new Error(`Matière introuvable après import : ${grade.evaluationName}.`);
          const conflictKey = `${student.id}:${evaluation.id}`;
          if (conflictKeys.has(conflictKey)) {
            throw new Error(`Doublon interne détecté pour ${row.personRaw} / ${grade.evaluationName}.`);
          }
          conflictKeys.add(conflictKey);
          gradesPayload.push({
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

      const expectedForGroup = rows.reduce((sum, row) => sum + row.grades.length, 0);
      if (gradesPayload.length !== expectedForGroup) {
        throw new Error(`Import incomplet pour « ${session.name} » : ${expectedForGroup} cellules attendues, ${gradesPayload.length} préparées.`);
      }

      for (const batch of chunks(gradesPayload)) {
        const upsert = await admin.from('grades').upsert(batch, { onConflict: 'student_id,evaluation_id' });
        if (upsert.error) throw new Error(`Notes (${session.name}) : ${upsert.error.message}`);
        gradeCount += batch.length;
      }
    }

    if (gradeCount !== expectedCells) {
      throw new Error(`Import incomplet : ${expectedCells} cellules étaient attendues mais ${gradeCount} seulement ont été enregistrées.`);
    }

    const verification = await admin.from('grades').select('id', { count: 'exact', head: true }).eq('import_id', importId);
    if (verification.error) throw new Error(`Vérification de l’import : ${verification.error.message}`);
    const verifiedGradeCount = verification.count || 0;
    if (verifiedGradeCount !== gradeCount) {
      throw new Error(`Vérification de l’import : ${gradeCount} cellules ont été envoyées mais ${verifiedGradeCount} seulement sont rattachées à cet import.`);
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
    for (const sessionId of touchedSessionIds) debtSync.push(await syncDebtsForSession(sessionId, auth.user.id));

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
