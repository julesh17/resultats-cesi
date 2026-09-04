import { internalEmail } from './utils';

export function validateUsername(username: string): string | null {
  const clean = username.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(clean)) {
    return 'Le pseudo doit contenir 3 à 40 caractères : lettres non accentuées, chiffres, point, tiret ou underscore.';
  }
  return null;
}

export { internalEmail };
