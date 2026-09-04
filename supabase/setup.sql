-- Résultats CESI — initialisation Supabase
-- À exécuter UNE FOIS dans Supabase > SQL Editor > New query.

create extension if not exists pgcrypto;

-- Types
DO $$ BEGIN
  create type public.cycle_type as enum ('ingenieur', 'cpi');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  create type public.absence_status as enum ('AJ', 'ANJ');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  create type public.debt_status as enum ('pending', 'validated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  create type public.jury_opinion as enum ('favorable', 'reserve', 'defavorable');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  create type public.import_kind as enum ('notes', 'referentiel');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username = lower(username)),
  display_name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  analytic_code text not null unique,
  cycle public.cycle_type not null,
  campus text default 'Toulouse',
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.session_years (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  label text not null check (label ~ '^A[1-5]$'),
  sort_order smallint not null,
  unique(session_id, label)
);

create table if not exists public.semesters (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  year_id uuid not null references public.session_years(id) on delete cascade,
  number smallint not null check (number between 1 and 10),
  unique(session_id, number)
);

create table if not exists public.session_subscriptions (
  user_id uuid not null references public.profiles(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(user_id, session_id)
);

create table if not exists public.students (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  person_key text not null,
  first_name text not null default '',
  last_name text not null default '',
  option_name text,
  supplementary_info text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(session_id, person_key)
);

create table if not exists public.ues (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  code text,
  name text not null,
  semester smallint not null check (semester between 1 and 10),
  ects numeric(6,2),
  is_enterprise boolean not null default false,
  source_axis text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(session_id, semester, name)
);

create table if not exists public.evaluations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  semester smallint not null check (semester between 1 and 10),
  name text not null,
  normalized_name text not null,
  source_name text,
  coefficient numeric(8,3) not null default 1 check (coefficient >= 0),
  ue_id uuid references public.ues(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(session_id, semester, normalized_name)
);

create table if not exists public.import_history (
  id uuid primary key default gen_random_uuid(),
  kind public.import_kind not null,
  file_name text not null,
  storage_path text not null,
  session_id uuid references public.sessions(id) on delete set null,
  imported_by uuid references public.profiles(id) on delete set null,
  rows_count integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.grades (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete cascade,
  evaluation_id uuid not null references public.evaluations(id) on delete cascade,
  raw_mention text,
  initial_mention text check (initial_mention is null or initial_mention in ('A','B','C','D')),
  final_mention text check (final_mention is null or final_mention in ('A','B','C','D')),
  numeric_note_text text,
  absence public.absence_status,
  import_id uuid references public.import_history(id) on delete set null,
  manual_override boolean not null default false,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(student_id, evaluation_id)
);

create table if not exists public.debts (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete cascade,
  ue_id uuid not null references public.ues(id) on delete cascade,
  origin_year_label text not null,
  origin_semester smallint not null check (origin_semester between 1 and 10),
  status public.debt_status not null default 'pending',
  validated_at timestamptz,
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(student_id, ue_id, origin_semester)
);

create table if not exists public.jury_records (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete cascade,
  year_label text not null check (year_label ~ '^A[1-5]$'),
  opinion_override public.jury_opinion,
  major_behavior_issue boolean not null default false,
  previous_recommendations_respected boolean not null default true,
  supplementary_notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(student_id, year_label)
);

create table if not exists public.preconisations (
  id smallint primary key,
  category text not null,
  text text not null
);

create table if not exists public.jury_preconisations (
  jury_record_id uuid not null references public.jury_records(id) on delete cascade,
  preconisation_id smallint not null references public.preconisations(id) on delete restrict,
  is_auto boolean not null default false,
  created_at timestamptz not null default now(),
  primary key(jury_record_id, preconisation_id)
);

-- Indexes utiles
alter table public.ues add column if not exists active boolean not null default true;

create index if not exists idx_students_session on public.students(session_id);
create index if not exists idx_evaluations_session_semester on public.evaluations(session_id, semester);
create index if not exists idx_ues_session_semester on public.ues(session_id, semester);
create index if not exists idx_grades_student on public.grades(student_id);
create index if not exists idx_grades_evaluation on public.grades(evaluation_id);
create index if not exists idx_debts_student_status on public.debts(student_id, status);
create index if not exists idx_jury_student_year on public.jury_records(student_id, year_label);

-- updated_at automatique
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_sessions_updated_at on public.sessions;
create trigger trg_sessions_updated_at before update on public.sessions for each row execute function public.set_updated_at();
drop trigger if exists trg_students_updated_at on public.students;
create trigger trg_students_updated_at before update on public.students for each row execute function public.set_updated_at();
drop trigger if exists trg_ues_updated_at on public.ues;
create trigger trg_ues_updated_at before update on public.ues for each row execute function public.set_updated_at();
drop trigger if exists trg_evaluations_updated_at on public.evaluations;
create trigger trg_evaluations_updated_at before update on public.evaluations for each row execute function public.set_updated_at();
drop trigger if exists trg_grades_updated_at on public.grades;
create trigger trg_grades_updated_at before update on public.grades for each row execute function public.set_updated_at();
drop trigger if exists trg_debts_updated_at on public.debts;
create trigger trg_debts_updated_at before update on public.debts for each row execute function public.set_updated_at();
drop trigger if exists trg_jury_updated_at on public.jury_records;
create trigger trg_jury_updated_at before update on public.jury_records for each row execute function public.set_updated_at();

-- Une session crée automatiquement ses années et semestres.
create or replace function public.create_session_structure()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  y uuid;
begin
  if new.cycle = 'ingenieur' then
    insert into public.session_years(session_id, label, sort_order) values (new.id, 'A3', 1) returning id into y;
    insert into public.semesters(session_id, year_id, number) values (new.id, y, 5), (new.id, y, 6);
    insert into public.session_years(session_id, label, sort_order) values (new.id, 'A4', 2) returning id into y;
    insert into public.semesters(session_id, year_id, number) values (new.id, y, 7), (new.id, y, 8);
    insert into public.session_years(session_id, label, sort_order) values (new.id, 'A5', 3) returning id into y;
    insert into public.semesters(session_id, year_id, number) values (new.id, y, 9), (new.id, y, 10);
  else
    insert into public.session_years(session_id, label, sort_order) values (new.id, 'A1', 1) returning id into y;
    insert into public.semesters(session_id, year_id, number) values (new.id, y, 1), (new.id, y, 2);
    insert into public.session_years(session_id, label, sort_order) values (new.id, 'A2', 2) returning id into y;
    insert into public.semesters(session_id, year_id, number) values (new.id, y, 3), (new.id, y, 4);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_create_session_structure on public.sessions;
create trigger trg_create_session_structure after insert on public.sessions for each row execute function public.create_session_structure();

-- Préconisations officielles fournies avec le projet.
insert into public.preconisations(id, category, text) values
(1, 'Positif', 'Le jury vous félicite pour vos résultats et vous invite à continuer ainsi.'),
(2, 'Positif', 'L’ensemble de vos résultats est satisfaisant, le jury vous invite à continuer ainsi.'),
(3, 'Positif', 'Le jury constate une amélioration de votre implication dans la formation et vous encourage à continuer ainsi.'),
(4, 'Positif', 'Le jury constate une amélioration de vos résultats en entreprise et vous encourage à continuer ainsi.'),
(5, 'Positif', 'Les préconisations faites par le jury précédent ont été prises en compte et le jury vous encourage à continuer ainsi.'),
(6, 'Positif', 'Le jury constate une amélioration de vos résultats académiques et vous encourage à continuer ainsi.'),
(7, 'Négatif', 'Passage conditionné à la validation d''une ou plusieurs UE de l''année précédente.'),
(8, 'Négatif', 'Passage conditionné à la validation de l''UE "Stage en entreprise" lors du prochain stage.'),
(9, 'Négatif', 'Le jury attend de vous un comportement professionnel en adéquation avec la posture ingénieur.'),
(10, 'Négatif', 'Le jury attend de recevoir les éléments en entreprise pour pouvoir statuer.'),
(11, 'Négatif', 'Le jury vous alerte sur la nécessité de réaliser votre période internationale, sinon votre diplôme est en danger.'),
(12, 'Négatif', 'Le jury vous alerte sur la nécessité de valider votre Initiation à la Recherche, sinon l''obtention de votre diplôme est en danger.'),
(13, 'Négatif', 'Le jury vous alerte sur la nécessité de valider votre Application de la Démarche Scientifique, sinon l''obtention de votre diplôme est en danger.'),
(14, 'Négatif', 'Le jury vous alerte que plusieurs rattrapages sont en cours. En fonction de vos résultats, l’obtention de votre diplôme peut être mise en danger.'),
(15, 'Négatif', 'Le jury ne voit pas de prise en compte des préconisations faites dans le jury précédent, l’obtention de votre diplôme est en danger.'),
(16, 'Négatif', 'Le jury constate une baisse dans vos résultats et vous invite à mettre en place les actions nécessaires pour améliorer ceux des prochains semestres.'),
(17, 'Négatif', 'Le jury vous demande plus de régularité dans le travail des différentes matières abordées'),
(18, 'Négatif', 'Le jury vous demande de vous impliquer plus dans le travail de groupe.'),
(19, 'Négatif', 'Le jury vous demande de respecter les échéances fixées par l’équipe pédagogique.'),
(20, 'Négatif', 'Le jury vous demande de prendre en compte les remarques de votre tuteur de stage pour améliorer vos résultats.'),
(21, 'Négatif', 'Le jury vous demande de prendre en compte les remarques de votre tuteur d''entreprise pour améliorer vos résultats.'),
(22, 'Négatif', 'Le jury vous demande de ne plus avoir de retards et/ou d''absences injustifiées. Cette demande sera vérifiée au prochain jury et le non-respect de cette préconisation pourrait remettre en cause l’obtention de votre diplôme.'),
(23, 'Négatif', 'Compte tenu du nombre d’Unités d''enseignement non validées, le jury vous propose d’effectuer une année supplémentaire pour mener à bien la suite de votre formation.'),
(24, 'Négatif', 'L''obtention du diplôme n''est plus possible, le jury demande l''arrêt de la formation.'),
(25, 'TOEIC', 'Le jury vous demande de mettre en place un plan d’action pour atteindre le score TOEIC exigé pour votre diplomation. Compte-tenu de votre niveau actuel en anglais, l''obtention de votre diplôme est en danger.'),
(26, 'TOEIC', 'Le jury constate une progression de votre score TOEIC et vous encourage à continuer ainsi.')
on conflict (id) do update set category = excluded.category, text = excluded.text;

-- Stockage privé des Excel importés (les imports applicatifs utilisent une clé secrète côté serveur).
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values (
  'imports',
  'imports',
  false,
  15728640,
  array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
)
on conflict (id) do update set public = false;

-- Tous les comptes connectés peuvent voir et modifier les données pédagogiques.
-- La clé Supabase secrète reste uniquement côté serveur pour les imports et la création de comptes.
alter table public.profiles enable row level security;
alter table public.sessions enable row level security;
alter table public.session_years enable row level security;
alter table public.semesters enable row level security;
alter table public.session_subscriptions enable row level security;
alter table public.students enable row level security;
alter table public.ues enable row level security;
alter table public.evaluations enable row level security;
alter table public.import_history enable row level security;
alter table public.grades enable row level security;
alter table public.debts enable row level security;
alter table public.jury_records enable row level security;
alter table public.preconisations enable row level security;
alter table public.jury_preconisations enable row level security;

DO $$
declare
  t text;
begin
  foreach t in array array[
    'profiles','sessions','session_years','semesters','session_subscriptions','students','ues',
    'evaluations','import_history','grades','debts','jury_records','preconisations','jury_preconisations'
  ]
  loop
    execute format('drop policy if exists authenticated_all on public.%I', t);
    execute format('create policy authenticated_all on public.%I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- Lecture des préconisations possible uniquement après connexion (comme le reste de l'application).
