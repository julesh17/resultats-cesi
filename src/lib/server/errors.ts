import 'server-only';

export function publicServerError(error: unknown, fallback = 'Une erreur technique est survenue.') {
  const message = error instanceof Error ? error.message : String(error || '');
  console.error(error);

  const lower = message.toLowerCase();
  if (
    lower.includes('permission denied') ||
    lower.includes('row-level security') ||
    lower.includes('violates row-level security') ||
    lower.includes('schema cache') ||
    lower.includes('pgrst') ||
    lower.includes('jwt') ||
    lower.includes('supabase serveur')
  ) {
    return 'Impossible d’accéder aux données pour le moment.';
  }

  return message || fallback;
}
