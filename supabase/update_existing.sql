-- Résultats CESI — mise à jour d'une base déjà initialisée
-- À exécuter UNE FOIS dans Supabase > SQL Editor > New query > Run.
--
-- Cette migration :
-- 1) corrige définitivement les « permission denied for table ... » ;
-- 2) conserve/crée automatiquement le profil à la création d'un compte ;
-- 3) supprime l'ancien champ campus ;
-- 4) rend le code analytique insensible à la casse ;
-- 5) autorise les sessions créées automatiquement par import à avoir
--    temporairement un code analytique vide, à renseigner ensuite.

-- -----------------------------------------------------------------------------
-- 1. Profil automatique lors d'une création de compte
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text;
  v_display_name text;
begin
  v_username := lower(trim(coalesce(
    nullif(new.raw_user_meta_data ->> 'username', ''),
    split_part(coalesce(new.email, ''), '@', 1)
  )));
  v_display_name := trim(coalesce(
    nullif(new.raw_user_meta_data ->> 'display_name', ''),
    nullif(new.raw_user_meta_data ->> 'username', ''),
    split_part(coalesce(new.email, ''), '@', 1)
  ));

  if v_username = '' then
    raise exception 'Pseudo absent lors de la création du compte.';
  end if;
  if v_display_name = '' then
    v_display_name := v_username;
  end if;

  insert into public.profiles (id, username, display_name)
  values (new.id, v_username, v_display_name)
  on conflict (id) do update
    set username = excluded.username,
        display_name = excluded.display_name;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- Répare les comptes Auth éventuellement créés avant le correctif.
insert into public.profiles (id, username, display_name)
select
  u.id,
  lower(trim(coalesce(
    nullif(u.raw_user_meta_data ->> 'username', ''),
    split_part(u.email, '@', 1)
  ))),
  trim(coalesce(
    nullif(u.raw_user_meta_data ->> 'display_name', ''),
    nullif(u.raw_user_meta_data ->> 'username', ''),
    split_part(u.email, '@', 1)
  ))
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id)
  and coalesce(u.email, '') <> ''
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- 2. Sessions : pas de campus + code analytique insensible à la casse
-- -----------------------------------------------------------------------------
alter table public.sessions alter column analytic_code drop not null;
alter table public.sessions drop column if exists campus;

-- Si des doublons ne différant que par la casse existent déjà, on garde le code
-- sur la session la plus ancienne et on vide seulement le code des suivantes.
-- Aucune session ni donnée pédagogique n'est supprimée.
with ranked_codes as (
  select
    id,
    row_number() over (
      partition by lower(trim(analytic_code))
      order by created_at nulls last, id
    ) as rn
  from public.sessions
  where nullif(trim(analytic_code), '') is not null
)
update public.sessions s
set analytic_code = null
from ranked_codes r
where s.id = r.id and r.rn > 1;

update public.sessions
set analytic_code = null
where analytic_code is not null and trim(analytic_code) = '';

update public.sessions
set analytic_code = lower(trim(analytic_code))
where analytic_code is not null;

create or replace function public.normalize_session_analytic_code()
returns trigger
language plpgsql
as $$
begin
  new.analytic_code := nullif(lower(trim(new.analytic_code)), '');
  return new;
end;
$$;

drop trigger if exists trg_normalize_session_analytic_code on public.sessions;
create trigger trg_normalize_session_analytic_code
before insert or update of analytic_code on public.sessions
for each row execute function public.normalize_session_analytic_code();

create unique index if not exists sessions_analytic_code_ci_unique
on public.sessions (lower(analytic_code))
where analytic_code is not null;

-- -----------------------------------------------------------------------------
-- 3. RLS + privilèges PostgreSQL
-- -----------------------------------------------------------------------------
-- Deux chemins accèdent aux données :
--   - le navigateur, avec le rôle authenticated ;
--   - les routes API Vercel (imports, création de compte, synchronisation),
--     avec la clé serveur et donc le rôle service_role.
-- Les deux rôles doivent donc disposer des privilèges SQL de table. Le rôle
-- service_role contourne RLS, mais il a malgré tout besoin des GRANT PostgreSQL.

grant usage on schema public to authenticated, service_role;

DO $$
declare
  t text;
begin
  foreach t in array array[
    'profiles','sessions','session_years','semesters','session_subscriptions','students','ues',
    'evaluations','import_history','grades','debts','jury_records','preconisations','jury_preconisations'
  ]
  loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('drop policy if exists authenticated_all on public.%I', t);
      execute format(
        'create policy authenticated_all on public.%I for all to authenticated using (true) with check (true)',
        t
      );

      -- Accès direct depuis le navigateur après authentification.
      execute format('grant select, insert, update, delete on table public.%I to authenticated', t);

      -- Accès des routes API serveur utilisant SUPABASE_SECRET_KEY /
      -- SUPABASE_SERVICE_ROLE_KEY.
      execute format('grant all privileges on table public.%I to service_role', t);
    end if;
  end loop;
end $$;

grant usage, select on all sequences in schema public to authenticated;
grant all privileges on all sequences in schema public to service_role;
grant execute on all functions in schema public to authenticated, service_role;

-- Les futurs objets créés dans public héritent des mêmes droits.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant all privileges on tables to service_role;
alter default privileges in schema public
  grant usage, select on sequences to authenticated;
alter default privileges in schema public
  grant all privileges on sequences to service_role;
alter default privileges in schema public
  grant execute on functions to authenticated, service_role;



-- -----------------------------------------------------------------------------
-- 4. Jury : permettre un avis explicitement indéterminé
-- -----------------------------------------------------------------------------
-- Requis par les raccourcis clavier et l'édition manuelle du jury.
alter type public.jury_opinion add value if not exists 'indetermine';


-- -----------------------------------------------------------------------------
-- 5. Jury : possibilité d'exclure certaines UE du calcul
-- -----------------------------------------------------------------------------
alter table public.ues add column if not exists exclude_from_jury boolean not null default false;

-- Contrôle final. Chaque table doit afficher TRUE pour authenticated_select et
-- service_role_select. service_role_insert doit également être TRUE.
select
  c.relname as table_name,
  has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select,
  has_table_privilege('authenticated', c.oid, 'INSERT') as authenticated_insert,
  has_table_privilege('service_role', c.oid, 'SELECT') as service_role_select,
  has_table_privilege('service_role', c.oid, 'INSERT') as service_role_insert
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'profiles','sessions','session_years','semesters','session_subscriptions','students','ues',
    'evaluations','import_history','grades','debts','jury_records','preconisations','jury_preconisations'
  )
order by c.relname;
