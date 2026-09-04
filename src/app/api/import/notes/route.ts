import { NextRequest, NextResponse } from 'next/server';
import { parseNotesWorkbook, fuzzyScore } from '@/lib/excel';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { requireApiUser } from '@/lib/server/auth';
import { syncDebtsForSession } from '@/lib/server/debts';
import { slugify } from '@/lib/utils';

function chunks<T>(array: T[], size = 800) {
  const out: T[][] = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
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
    const sessionNames = [...new Set(parsedRows.map((r) => r.sessionName))];
    const admin = getSupabaseAdmin();
    const { data: sessionRows, error: sessionError } = await admin.from('sessions').select('*').in('name', sessionNames);
    if (sessionError) throw new Error(sessionError.message);
    const sessionByName = new Map((sessionRows || []).map((s) => [s.name, s]));
    const unknown = sessionNames.filter((name) => !sessionByName.has(name));
    if (unknown.length) {
      return NextResponse.json({
        error: 'Certaines sessions du fichier n’existent pas encore. Créez-les d’abord dans l’onglet Sessions.',
        unknown_sessions: unknown,
      }, { status: 400 });
    }

    const safeName = `${Date.now()}-${slugify(file.name.replace(/\.xlsx$/i, '')) || 'notes'}.xlsx`;
    const storagePath = `notes/${safeName}`;
    const upload = await admin.storage.from('imports').upload(storagePath, buffer, {
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      upsert: false,
    });
    if (upload.error) throw new Error(`Stockage du fichier : ${upload.error.message}`);

    const historyInsert = await admin.from('import_history').insert({
      kind: 'notes',
      file_name: file.name,
      storage_path: storagePath,
      session_id: null,
      imported_by: auth.user.id,
      rows_count: parsedRows.length,
      metadata: { sessions: sessionNames },
    }).select('id').single();
    if (historyInsert.error) throw new Error(historyInsert.error.message);
    const importId = historyInsert.data.id;

    let studentCount = 0;
    let evaluationCount = 0;
    let gradeCount = 0;
    const touchedSessionIds = new Set<string>();

    for (const sessionName of sessionNames) {
      const session = sessionByName.get(sessionName)!;
      touchedSessionIds.add(session.id);
      const rows = parsedRows.filter((r) => r.sessionName === sessionName);

      const studentPayload = rows.map((r) => ({
        session_id: session.id,
        person_key: r.personKey,
        first_name: r.firstName,
        last_name: r.lastName,
        option_name: r.optionName,
        active: true,
      }));
      const { data: importedStudents, error: studentError } = await admin
        .from('students')
        .upsert(studentPayload, { onConflict: 'session_id,person_key' })
        .select('*');
      if (studentError) throw new Error(`Étudiants (${sessionName}) : ${studentError.message}`);
      studentCount += importedStudents?.length || 0;
      const studentByKey = new Map((importedStudents || []).map((s) => [s.person_key, s]));

      const { data: existingEvals, error: evalReadError } = await admin
        .from('evaluations')
        .select('*')
        .eq('session_id', session.id);
      if (evalReadError) throw new Error(evalReadError.message);
      const localEvals = [...(existingEvals || [])];

      const gradeDescriptors = rows.flatMap((r) => r.grades);
      const uniqueIncoming = new Map<string, (typeof gradeDescriptors)[number]>();
      gradeDescriptors.forEach((g) => uniqueIncoming.set(`${g.semester}:${g.normalizedName}`, g));

      for (const incoming of uniqueIncoming.values()) {
        let match = localEvals.find((e) => e.semester === incoming.semester && e.normalized_name === incoming.normalizedName);
        if (!match) {
          const candidates = localEvals
            .filter((e) => e.semester === incoming.semester)
            .map((e) => ({ e, score: fuzzyScore(e.name, incoming.evaluationName) }))
            .sort((a, b) => b.score - a.score);
          if (candidates[0]?.score >= 60) match = candidates[0].e;
        }
        if (match) {
          if (!match.active) {
            await admin.from('evaluations').update({ active: true, source_name: incoming.evaluationName }).eq('id', match.id);
            match.active = true;
          }
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
          evaluationCount += 1;
        }
      }

      const gradesPayload = [] as Array<Record<string, unknown>>;
      for (const row of rows) {
        const student = studentByKey.get(row.personKey);
        if (!student) continue;
        for (const g of row.grades) {
          let evaluation = localEvals.find((e) => e.semester === g.semester && e.normalized_name === g.normalizedName);
          if (!evaluation) {
            evaluation = localEvals
              .filter((e) => e.semester === g.semester)
              .map((e) => ({ e, score: fuzzyScore(e.name, g.evaluationName) }))
              .sort((a, b) => b.score - a.score)[0]?.e;
          }
          if (!evaluation) continue;
          gradesPayload.push({
            student_id: student.id,
            evaluation_id: evaluation.id,
            raw_mention: g.rawMention,
            initial_mention: g.initialMention,
            final_mention: g.finalMention,
            numeric_note_text: g.numericNoteText,
            absence: g.absence,
            import_id: importId,
            manual_override: false,
            updated_by: auth.user.id,
          });
        }
      }

      for (const batch of chunks(gradesPayload)) {
        const upsert = await admin.from('grades').upsert(batch, { onConflict: 'student_id,evaluation_id' });
        if (upsert.error) throw new Error(`Notes (${sessionName}) : ${upsert.error.message}`);
        gradeCount += batch.length;
      }
    }

    const debtSync: Array<{ detected: number; inserted: number }> = [];
    for (const sessionId of touchedSessionIds) {
      debtSync.push(await syncDebtsForSession(sessionId, auth.user.id));
    }

    return NextResponse.json({
      ok: true,
      sessions: sessionNames.length,
      students: studentCount,
      evaluations_created: evaluationCount,
      grades: gradeCount,
      debts_detected: debtSync.reduce((s, x) => s + x.detected, 0),
      debts_created: debtSync.reduce((s, x) => s + x.inserted, 0),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Import impossible.' }, { status: 500 });
  }
}
