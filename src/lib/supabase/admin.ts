import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export function getSupabaseAdmin(): SupabaseClient<any> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Configuration Supabase serveur incomplète.');
  if (key.startsWith('sb_publishable_')) {
    throw new Error('Configuration Supabase serveur invalide.');
  }
  return createClient<any>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
