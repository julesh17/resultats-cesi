export type CycleType = 'ingenieur' | 'cpi';
export type AbsenceStatus = 'AJ' | 'ANJ';
export type DebtStatus = 'pending' | 'validated';
export type JuryOpinion = 'favorable' | 'reserve' | 'defavorable' | 'indetermine';

export interface Profile {
  id: string;
  username: string;
  display_name: string;
}

export interface CesiSession {
  id: string;
  name: string;
  analytic_code: string | null;
  cycle: CycleType;
  created_at?: string;
}

export interface Student {
  id: string;
  session_id: string;
  person_key: string;
  first_name: string;
  last_name: string;
  option_name: string | null;
  supplementary_info: string | null;
  active: boolean;
}

export interface UE {
  id: string;
  session_id: string;
  code: string | null;
  name: string;
  semester: number;
  ects: number | null;
  is_enterprise: boolean;
  source_axis: string | null;
  active: boolean;
  exclude_from_jury: boolean;
}

export interface Evaluation {
  id: string;
  session_id: string;
  semester: number;
  name: string;
  normalized_name: string;
  source_key: string | null;
  source_name: string | null;
  coefficient: number;
  ue_id: string | null;
  active: boolean;
}

export interface Grade {
  id?: string;
  student_id: string;
  evaluation_id: string;
  raw_mention: string | null;
  initial_mention: string | null;
  final_mention: string | null;
  numeric_note_text: string | null;
  absence: AbsenceStatus | null;
  manual_override?: boolean;
  updated_at?: string;
}

export interface Debt {
  id: string;
  student_id: string;
  ue_id: string;
  origin_year_label: string;
  origin_semester: number;
  status: DebtStatus;
  validated_at: string | null;
  notes: string | null;
  status_manual?: boolean;
  status_updated_at?: string | null;
  status_updated_by?: string | null;
  students?: Pick<Student, 'id' | 'first_name' | 'last_name' | 'session_id'>;
  ues?: Pick<UE, 'id' | 'name' | 'semester'>;
}

export interface Preconisation {
  id: number;
  category: string;
  text: string;
}

export interface JuryRecord {
  id: string;
  student_id: string;
  year_label: string;
  opinion_override: JuryOpinion | null;
  major_behavior_issue: boolean;
  previous_recommendations_respected: boolean;
  supplementary_notes: string | null;
  preconisations_locked?: boolean;
}

export interface UEComputedResult {
  ue: UE;
  mention: 'A' | 'B' | 'C' | 'D' | null;
  weightedAverage: number | null;
  validated: boolean;
  compensation: boolean;
  missing: boolean;
  elements: Array<{
    evaluation: Evaluation;
    grade: Grade | null;
    value: number | null;
    inferredAbsence: boolean;
  }>;
}

export interface JuryComputed {
  automaticOpinion: Exclude<JuryOpinion, 'indetermine'> | null;
  semesterValidated: Record<number, boolean | null>;
  semesterComplete: Record<number, boolean>;
  yearComplete: boolean;
  finalizedUeCount: number;
  ectsAcquired: number;
  academicUeNotValidated: number;
  totalUeNotValidated: number;
  pendingPreviousDebts: number;
  validatedPreviousDebts: number;
  absences: number;
  blankAbsences: number;
  justifiedAbsences: number;
  unjustifiedAbsences: number;
  missingGrades: number;
  resitCount: number;
  reasons: string[];
}
