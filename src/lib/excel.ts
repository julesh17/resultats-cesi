import * as XLSX from 'xlsx';
import { normalizeText, safeNumber, shortEvaluationName } from './utils';
import { parseMention } from './results';

export type NotesImportRow = {
  sessionName: string;
  sessionAnalyticCode: string | null;
  personRaw: string;
  firstName: string;
  lastName: string;
  personKey: string;
  optionName: string | null;
  grades: Array<{
    evaluationName: string;
    sourceKey: string;
    normalizedName: string;
    semester: number;
    rawMention: string | null;
    initialMention: string | null;
    finalMention: string | null;
    numericNoteText: string | null;
    absence: 'AJ' | 'ANJ' | null;
  }>;
};

export type ReferentielRow = {
  ueCode: string | null;
  ueName: string;
  semester: number;
  ects: number | null;
  axis: string | null;
  isEnterprise: boolean;
  evaluationName: string;
  normalizedName: string;
  coefficient: number;
};

function readFirstSheet(buffer: ArrayBuffer) {
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('Le classeur Excel ne contient aucun onglet.');
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: false });
}

function splitPerson(person: string) {
  const clean = person.trim();
  if (clean.includes(',')) {
    const [last, ...rest] = clean.split(',');
    return { lastName: last.trim(), firstName: rest.join(',').trim() };
  }
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { lastName: clean, firstName: '' };
  return { lastName: parts[0], firstName: parts.slice(1).join(' ') };
}

function normalizedPersonKey(person: string) {
  return normalizeText(person).replace(/\s+/g, '-');
}

function semesterFromLabel(label: string): number | null {
  const patterns = [
    /semestre\s*(10|[1-9])/i,
    /\bS(10|[1-9])\b/i,
  ];
  for (const pattern of patterns) {
    const m = label.match(pattern);
    if (m) return Number(m[1]);
  }
  return null;
}

export function parseNotesWorkbook(buffer: ArrayBuffer): NotesImportRow[] {
  const rows = readFirstSheet(buffer);
  if (!rows.length) throw new Error('Le fichier de notes est vide.');
  const columns = Object.keys(rows[0]);
  if (!columns.includes('Session')) throw new Error("Colonne 'Session' introuvable.");
  if (!columns.includes('Personne')) throw new Error("Colonne 'Personne' introuvable.");

  const analyticCodeAliases = [
    'Code analytique',
    'Code analytique session',
    'Code analytique de la session',
    'Code session',
  ].map(normalizeText);
  const analyticCodeColumn = columns.find((c) => analyticCodeAliases.includes(normalizeText(c)));

  const evalColumns = columns.filter((c) => /^Eval\s*-/i.test(c));
  if (!evalColumns.length) throw new Error("Aucune colonne 'Eval - ...' trouvée.");

  // Les colonnes Seme/Notes décrivent l'évaluation elle-même. Le semestre est donc
  // déterminé une fois par colonne (à partir de la première valeur disponible), plutôt
  // que ligne par ligne. Cela évite de perdre une lettre lorsqu'une cellule Seme isolée
  // est vide alors que la mention est bien présente.
  const descriptors = evalColumns.map((evalColumn) => {
    const suffix = shortEvaluationName(evalColumn);
    const semeColumn = columns.find((c) => normalizeText(c) === normalizeText(`Seme - ${suffix}`));
    const notesColumn = columns.find((c) => normalizeText(c) === normalizeText(`Notes - ${suffix}`));
    const absenceColumn = columns.find((c) => {
      const n = normalizeText(c);
      return n === normalizeText(`Abs - ${suffix}`)
        || n === normalizeText(`Absence - ${suffix}`)
        || n === normalizeText(`Absences - ${suffix}`);
    });

    let semester: number | null = null;
    if (semeColumn) {
      for (const row of rows) {
        const candidate = safeNumber(row[semeColumn]);
        if (candidate && candidate >= 1 && candidate <= 10) {
          semester = candidate;
          break;
        }
      }
    }
    semester = semester || semesterFromLabel(suffix);

    return {
      evalColumn,
      suffix,
      sourceKey: `excel:${evalColumn.trim()}`,
      normalizedName: normalizeText(suffix),
      semeColumn,
      notesColumn,
      absenceColumn,
      semester: semester || 0,
    };
  });

  const invalidDescriptors = descriptors.filter((descriptor) => descriptor.semester < 1 || descriptor.semester > 10);
  if (invalidDescriptors.length) {
    throw new Error(
      `Semestre introuvable pour ${invalidDescriptors.length} matière(s) : ${invalidDescriptors.slice(0, 8).map((item) => item.suffix).join(', ')}${invalidDescriptors.length > 8 ? '…' : ''}`
    );
  }

  return rows
    .filter((row) => String(row.Session || '').trim() && String(row.Personne || '').trim())
    .map((row) => {
      const sessionName = String(row.Session).trim();
      const sessionAnalyticCode = analyticCodeColumn && row[analyticCodeColumn] !== null && row[analyticCodeColumn] !== undefined
        ? String(row[analyticCodeColumn]).trim().toLowerCase() || null
        : null;
      const personRaw = String(row.Personne).trim();
      const { firstName, lastName } = splitPerson(personRaw);

      const grades = descriptors.map((descriptor) => {
        const parsed = parseMention(row[descriptor.evalColumn]);
        const explicitAbsenceRaw = descriptor.absenceColumn
          ? String(row[descriptor.absenceColumn] || '').trim().toUpperCase()
          : '';
        const absence = explicitAbsenceRaw === 'AJ' || explicitAbsenceRaw === 'ANJ'
          ? explicitAbsenceRaw
          : parsed.absence;
        const numericRaw = descriptor.notesColumn ? row[descriptor.notesColumn] : null;
        const numericNoteText = numericRaw === null || numericRaw === undefined || String(numericRaw).trim() === ''
          ? null
          : String(numericRaw).trim();

        return {
          evaluationName: descriptor.suffix,
          sourceKey: descriptor.sourceKey,
          normalizedName: descriptor.normalizedName,
          semester: descriptor.semester,
          rawMention: absence ? null : parsed.raw,
          initialMention: absence ? null : parsed.initial,
          finalMention: absence ? null : parsed.final,
          numericNoteText,
          absence,
        };
      });

      return {
        sessionName,
        sessionAnalyticCode,
        personRaw,
        firstName,
        lastName,
        personKey: normalizedPersonKey(personRaw),
        optionName: row['Option choisie'] ? String(row['Option choisie']).trim() : null,
        grades,
      };
    });
}

export function parseReferentielWorkbook(buffer: ArrayBuffer): ReferentielRow[] {
  const rows = readFirstSheet(buffer);
  if (!rows.length) throw new Error('Le référentiel est vide.');
  const required = ['Libelle Unite Enseignement', 'Semestre Unite Enseignement', 'Libelle Element Evaluable', 'Coefficient Element Evaluable'];
  for (const column of required) {
    if (!Object.prototype.hasOwnProperty.call(rows[0], column)) throw new Error(`Colonne '${column}' introuvable dans le référentiel.`);
  }

  return rows.flatMap((row) => {
    const ueName = String(row['Libelle Unite Enseignement'] || '').trim();
    const evaluationName = String(row['Libelle Element Evaluable'] || '').trim();
    const semester = safeNumber(row['Semestre Unite Enseignement']) || 0;
    const coefficient = safeNumber(row['Coefficient Element Evaluable']) || 0;
    if (!ueName || !evaluationName || !semester || coefficient <= 0) return [];
    const axis = row['Libelle Axe'] ? String(row['Libelle Axe']).trim() : null;
    const normalizedAxis = normalizeText(axis || '');
    const normalizedUe = normalizeText(ueName);
    const isEnterprise = normalizedAxis.includes('entreprise') || normalizedUe.includes('entreprise') || normalizedUe.includes('stage');
    return [{
      ueCode: row['Code Unite Enseignement'] ? String(row['Code Unite Enseignement']).trim() : null,
      ueName,
      semester,
      ects: safeNumber(row['Montant Credit ECTS Unite Enseignement']),
      axis,
      isEnterprise,
      evaluationName,
      normalizedName: normalizeText(evaluationName),
      coefficient,
    }];
  });
}

const STOP_WORDS = new Set(['', 'de', 'la', 'le', 'les', 'du', 'des', 'et', 'en', 'un', 'une', 'a', 'au', 'aux']);

// Reprend volontairement la règle de l'application Streamlit qui fonctionnait bien :
// égalité, inclusion, puis au moins trois mots significatifs communs.
export function fuzzyScore(a: string, b: string) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  if (na.includes(nb) || nb.includes(na)) return 90;
  const ta = new Set(na.split(/[\s\-:,()]+/).filter((x) => x.length > 0 && !STOP_WORDS.has(x)));
  const tb = new Set(nb.split(/[\s\-:,()]+/).filter((x) => x.length > 0 && !STOP_WORDS.has(x)));
  let common = 0;
  ta.forEach((word) => { if (tb.has(word)) common += 1; });
  return common >= 3 ? 60 + Math.min(common, 20) : 0;
}
