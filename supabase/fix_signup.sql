-- Résultats CESI — correction création de compte
-- À exécuter UNE FOIS dans Supabase > SQL Editor > New query > Run.
--
-- Cette correction crée automatiquement public.profiles à chaque création
-- d'un utilisateur dans Supabase Auth. La route /api/signup n'a donc plus
-- besoin d'insérer directement dans public.profiles.

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
  v_username := lower(trim(coalesce(new.raw_user_meta_data ->> 'username', '')));
  v_display_name := trim(coalesce(new.raw_user_meta_data ->> 'display_name', ''));

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

-- Répare aussi les éventuels utilisateurs Auth déjà créés sans profil.
insert into public.profiles (id, username, display_name)
select
  u.id,
  lower(trim(coalesce(u.raw_user_meta_data ->> 'username', split_part(u.email, '@', 1)))),
  trim(coalesce(
    nullif(u.raw_user_meta_data ->> 'display_name', ''),
    u.raw_user_meta_data ->> 'username',
    split_part(u.email, '@', 1)
  ))
from auth.users u
where not exists (
  select 1 from public.profiles p where p.id = u.id
)
and coalesce(u.email, '') <> ''
on conflict (id) do nothing;
