import { NextRequest, NextResponse } from 'next/server';
import { requireApiUser } from '@/lib/server/auth';
import { syncDebtsForSession } from '@/lib/server/debts';

export async function POST(request: NextRequest) {
  const auth = await requireApiUser(request);
  if (!auth.user) return NextResponse.json({ error: auth.error }, { status: 401 });
  try {
    const body = await request.json();
    const sessionId = String(body.session_id || '');
    if (!sessionId) return NextResponse.json({ error: 'Session manquante.' }, { status: 400 });
    const result = await syncDebtsForSession(sessionId, auth.user.id);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Erreur de synchronisation.' }, { status: 500 });
  }
}
