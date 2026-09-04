import 'server-only';
import { NextRequest } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

export async function requireApiUser(request: NextRequest) {
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
  if (!token) return { user: null, error: 'Session absente.' } as const;

  const admin = getSupabaseAdmin();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return { user: null, error: 'Session invalide ou expirée.' } as const;
  return { user: data.user, error: null } as const;
}
