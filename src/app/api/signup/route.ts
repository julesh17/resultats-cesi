import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { internalEmail, validateUsername } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const username = String(body.username || '').trim().toLowerCase();
    const displayName = String(body.displayName || '').trim();
    const password = String(body.password || '');
    const secret = String(body.secret || '');

    const usernameError = validateUsername(username);
    if (usernameError) return NextResponse.json({ error: usernameError }, { status: 400 });
    if (!displayName) return NextResponse.json({ error: 'Le nom affiché est obligatoire.' }, { status: 400 });
    if (password.length < 8) return NextResponse.json({ error: 'Le mot de passe doit contenir au moins 8 caractères.' }, { status: 400 });
    if (!process.env.ACCOUNT_CREATION_SECRET || secret !== process.env.ACCOUNT_CREATION_SECRET) {
      return NextResponse.json({ error: 'Mot de validation incorrect.' }, { status: 403 });
    }

    const admin = getSupabaseAdmin();
    const { data: existing } = await admin.from('profiles').select('id').eq('username', username).maybeSingle();
    if (existing) return NextResponse.json({ error: 'Ce pseudo existe déjà.' }, { status: 409 });

    const { data, error } = await admin.auth.admin.createUser({
      email: internalEmail(username),
      password,
      email_confirm: true,
      user_metadata: { username, display_name: displayName },
    });
    if (error || !data.user) return NextResponse.json({ error: error?.message || 'Création impossible.' }, { status: 400 });

    const profileInsert = await admin.from('profiles').insert({
      id: data.user.id,
      username,
      display_name: displayName,
    });
    if (profileInsert.error) {
      await admin.auth.admin.deleteUser(data.user.id);
      return NextResponse.json({ error: profileInsert.error.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Erreur inattendue.' }, { status: 500 });
  }
}
