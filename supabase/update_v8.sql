-- Résultats CESI v8 — migration depuis la v7
-- À exécuter UNE FOIS dans Supabase > SQL Editor.
-- Cette migration ne supprime aucune donnée pédagogique.

begin;

alter table public.debts
  add column if not exists status_manual boolean not null default false;

alter table public.debts
  add column if not exists status_updated_at timestamptz;

alter table public.debts
  add column if not exists status_updated_by uuid references public.profiles(id) on delete set null;

alter table public.jury_records
  add column if not exists preconisations_locked boolean not null default false;

-- Les choix de préconisations déjà enregistrés sont considérés comme des choix à conserver.
update public.jury_records jr
set preconisations_locked = true
where exists (
  select 1 from public.jury_preconisations jp where jp.jury_record_id = jr.id
);

-- Les statuts de dette existants sont conservés. Les synchronisations v8 ne modifient
-- jamais le statut d'une dette déjà matérialisée.
update public.debts
set status_manual = true,
    status_updated_at = coalesce(status_updated_at, updated_at)
where status in ('pending', 'validated');

commit;
