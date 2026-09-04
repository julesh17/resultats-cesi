import { NextRequest, NextResponse } from 'next/server';
import { parseReferentielWorkbook, fuzzyScore } from '@/lib/excel';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { requireApiUser } from '@/lib/server/auth';
import { syncDebtsForSession } from '@/lib/server/debts';
import { slugify } from '@/lib/utils';
import { publicServerError } from '@/lib/server/errors';

type UeDbRow = { id: string; semester: number; name: string };
type EvalDbRow = {
  id: string;
  semester: number;
  name: string;
  normalized_name: string;
  ue_id: string | null;
  coefficient: number;
};

export async function POST(request: NextRequest) {
  const auth = await requireApiUser(request);
  if (!auth.user) return NextResponse.json({ error: auth.error }, { status: 401 });

  try {
    const form = await request.formData();
    const file = form.get('file');
    const sessionId = String(form.get('session_id') || '');
    if (!(file instanceof File)) return NextResponse.json({ error: 'Fichier référentiel manquant.' }, { status: 400 });
    if (!sessionId) return NextResponse.json({ error: 'Session manquante.' }, { status: 400 });

    const admin = getSupabaseAdmin();
    const { data: session, error: sessionError } = await admin.from('sessions').select('*').eq('id', sessionId).single();
    if (sessionError || !session) return NextResponse.json({ error: 'Session introuvable.' }, { status: 404 });

    const buffer = await file.arrayBuffer();
    const parsed = parseReferentielWorkbook(buffer);
    const safeName = `${Date.now()}-${slugify(file.name.replace(/\.xlsx$/i, '')) || 'referentiel'}.xlsx`;
    const storagePath = `referentiels/${sessionId}/${safeName}`;
    const upload = await admin.storage.from('imports').upload(storagePath, buffer, {
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      upsert: false,
    });
    if (upload.error) throw new Error(`Stockage du fichier : ${upload.error.message}`);

    const history = await admin.from('import_history').insert({
      kind: 'referentiel',
      file_name: file.name,
      storage_path: storagePath,
      session_id: sessionId,
      imported_by: auth.user.id,
      rows_count: parsed.length,
      metadata: { session: session.name },
    }).select('id').single();
    if (history.error) throw new Error(history.error.message);

    const ueUnique = new Map<string, (typeof parsed)[number]>();
    parsed.forEach((r) => ueUnique.set(`${r.semester}:${r.ueName}`, r));

    // Un nouvel import de référentiel devient la source de vérité courante de la session.
    // Les anciennes UE sont désactivées (et non supprimées) afin de préserver les dettes historiques.
    const resetMappings = await admin.from('evaluations').update({ ue_id: null, coefficient: 1 }).eq('session_id', sessionId);
    if (resetMappings.error) throw new Error(`Réinitialisation du référentiel : ${resetMappings.error.message}`);
    const deactivateUes = await admin.from('ues').update({ active: false }).eq('session_id', sessionId);
    if (deactivateUes.error) throw new Error(`Mise à jour des anciennes UE : ${deactivateUes.error.message}`);

    const uePayload = [...ueUnique.values()].map((r) => ({
      session_id: sessionId,
      code: r.ueCode,
      name: r.ueName,
      semester: r.semester,
      ects: r.ects,
      is_enterprise: r.isEnterprise,
      source_axis: r.axis,
      active: true,
    }));
    const { data: upsertedUes, error: ueError } = await admin
      .from('ues')
      .upsert(uePayload, { onConflict: 'session_id,semester,name' })
      .select('*');
    if (ueError) throw new Error(`UE : ${ueError.message}`);
    const ueRows = (upsertedUes || []) as UeDbRow[];
    const ueByKey = new Map(ueRows.map((u) => [`${u.semester}:${u.name}`, u]));

    const { data: existingEvals, error: existingError } = await admin
      .from('evaluations')
      .select('*')
      .eq('session_id', sessionId);
    if (existingError) throw new Error(existingError.message);
    const localEvals = [...((existingEvals || []) as EvalDbRow[])];
    let matched = 0;
    let created = 0;

    for (const row of parsed) {
      const ue = ueByKey.get(`${row.semester}:${row.ueName}`);
      if (!ue) continue;
      let match = localEvals.find((e) => e.semester === row.semester && e.normalized_name === row.normalizedName);
      if (!match) {
        const best = localEvals
          .filter((e) => e.semester === row.semester)
          .map((e) => ({ e, score: fuzzyScore(e.name, row.evaluationName) }))
          .sort((a, b) => b.score - a.score)[0];
        if (best?.score >= 60) match = best.e;
      }

      if (match) {
        const update = await admin.from('evaluations').update({
          ue_id: ue.id,
          coefficient: row.coefficient,
          active: true,
        }).eq('id', match.id);
        if (update.error) throw new Error(update.error.message);
        match.ue_id = ue.id;
        match.coefficient = row.coefficient;
        matched += 1;
      } else {
        const insert = await admin.from('evaluations').insert({
          session_id: sessionId,
          semester: row.semester,
          name: row.evaluationName,
          normalized_name: row.normalizedName,
          source_name: row.evaluationName,
          coefficient: row.coefficient,
          ue_id: ue.id,
          active: true,
        }).select('*').single();
        if (insert.error) throw new Error(insert.error.message);
        localEvals.push(insert.data as EvalDbRow);
        created += 1;
      }
    }

    const debtSync = await syncDebtsForSession(sessionId, auth.user.id);
    return NextResponse.json({
      ok: true,
      ues: upsertedUes?.length || 0,
      evaluations_matched: matched,
      evaluations_created: created,
      debts_detected: debtSync.detected,
      debts_created: debtSync.inserted,
    });
  } catch (error) {
    return NextResponse.json({ error: publicServerError(error, 'Import impossible.') }, { status: 500 });
  }
}
