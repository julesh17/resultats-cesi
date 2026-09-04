export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}


export function normalizeAnalyticCode(value: string): string {
  return value.trim().toLowerCase();
}

export function slugify(value: string): string {
  return normalizeText(value).replace(/\s+/g, '-').replace(/^-+|-+$/g, '');
}

export function internalEmail(username: string): string {
  const clean = username.trim().toLowerCase();
  return `${clean}@resultats-cesi.local`;
}

export function displayStudent(firstName: string, lastName: string) {
  return `${firstName} ${lastName}`.trim();
}

export function yearToSemesters(yearLabel: string): number[] {
  const n = Number(yearLabel.replace(/\D/g, ''));
  if (!Number.isFinite(n)) return [];
  return [n * 2 - 1, n * 2];
}

export function semesterToYear(semester: number): string {
  return `A${Math.ceil(semester / 2)}`;
}

export function cycleYears(cycle: 'ingenieur' | 'cpi'): Array<{ label: string; semesters: number[] }> {
  return cycle === 'ingenieur'
    ? [
        { label: 'A3', semesters: [5, 6] },
        { label: 'A4', semesters: [7, 8] },
        { label: 'A5', semesters: [9, 10] },
      ]
    : [
        { label: 'A1', semesters: [1, 2] },
        { label: 'A2', semesters: [3, 4] },
      ];
}

export function shortEvaluationName(column: string): string {
  return column.replace(/^Eval\s*-\s*/i, '').trim();
}

export function safeNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}
