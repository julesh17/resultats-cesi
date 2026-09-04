import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { internalEmail, validateUsername } from '@/lib/auth';
import { publicServerError } from '@/lib/server/errors';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const username = String(body.username || '').trim().toLowerCase();
    const displayName = String(body.displayName || '').trim();
    const password = String(body.password || '');
    const secret = String(body.secret || '');

    const usernameError = validateUsername(username);
    if (usernameError) {
      return NextResponse.json({ error: usernameError }, { status: 400 });
    }

    if (!displayName) {
      return NextResponse.json({ error: 'Le nom affiché est obligatoire.' }, { status: 400 });
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: 'Le mot de passe doit contenir au moins 8 caractères.' },
        { status: 400 },
      );
    }

    if (!process.env.ACCOUNT_CREATION_SECRET || secret !== process.env.ACCOUNT_CREATION_SECRET) {
      return NextResponse.json({ error: 'Mot de validation incorrect.' }, { status: 403 });
    }

    const admin = getSupabaseAdmin();

    // Le profil public.profiles est créé automatiquement par un trigger Supabase
    // lors de la création de l'utilisateur Auth. On ne fait donc plus d'INSERT
    // direct dans public.profiles depuis cette route.
    const { data, error } = await admin.auth.admin.createUser({
      email: internalEmail(username),
      password,
      email_confirm: true,
      user_metadata: {
        username,
        display_name: displayName,
      },
    });

    if (error || !data.user) {
      const message = error?.message || 'Création impossible.';
      const lower = message.toLowerCase();

      if (lower.includes('already') || lower.includes('registered') || lower.includes('exists')) {
        return NextResponse.json({ error: 'Ce pseudo existe déjà.' }, { status: 409 });
      }

      return NextResponse.json({ error: message }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: publicServerError(error, 'Erreur inattendue.') },
      { status: 500 },
    );
  }
}
