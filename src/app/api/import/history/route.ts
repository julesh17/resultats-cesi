import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { requireApiUser } from '@/lib/server/auth';
import { publicServerError } from '@/lib/server/errors';

type HistoryRow = { id: string; storage_path: string | null };

export async function DELETE(request: NextRequest) {
  const auth = await requireApiUser(request);
  if (!auth.user) return NextResponse.json({ error: auth.error }, { status: 401 });

  try {
    const body = await request.json().catch(() => ({}));
    const id = typeof body?.id === 'string' ? body.id : null;
    const all = body?.all === true;
    if (!id && !all) return NextResponse.json({ error: 'Import à supprimer non précisé.' }, { status: 400 });

    const admin = getSupabaseAdmin();
    let rows: HistoryRow[] = [];
    if (all) {
      const read = await admin.from('import_history').select('id,storage_path');
      if (read.error) throw new Error(read.error.message);
      rows = (read.data || []) as HistoryRow[];
    } else {
      const read = await admin.from('import_history').select('id,storage_path').eq('id', id).maybeSingle();
      if (read.error) throw new Error(read.error.message);
      if (read.data) rows = [read.data as HistoryRow];
    }

    const paths = rows.map((row) => row.storage_path).filter((path): path is string => Boolean(path));
    if (paths.length) {
      for (let i = 0; i < paths.length; i += 100) {
        const removed = await admin.storage.from('imports').remove(paths.slice(i, i + 100));
        if (removed.error) throw new Error(`Suppression du fichier archivé : ${removed.error.message}`);
      }
    }

    const deletion = all
      ? await admin.from('import_history').delete().neq('id', '00000000-0000-0000-0000-000000000000')
      : await admin.from('import_history').delete().eq('id', id!);
    if (deletion.error) throw new Error(deletion.error.message);

    return NextResponse.json({ ok: true, deleted: rows.length });
  } catch (error) {
    return NextResponse.json({ error: publicServerError(error, 'Suppression impossible.') }, { status: 500 });
  }
}
