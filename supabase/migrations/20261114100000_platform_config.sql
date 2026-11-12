-- J12b — platform_config : paramètres GLOBAUX de la plateforme (palette de couleurs). ADR 016 (Proposed).
-- Retour arrière : supabase/rollbacks/20261114100000_platform_config.sql
--
-- Donnée globale, NON tenant : ni organization_id ni RLS par organisation (exception documentée à la règle
-- « table tenant = organization_id + RLS » : rien ici n'appartient à une organisation).
--  * AUCUN droit direct sur la table (anon, authenticated, service_role) ; RLS activée sans politique ;
--  * lecture : par public.get_platform_config, réservée à service_role (lecture SERVEUR, module
--    apps/web/lib/service/platform-config.ts) : la palette ne contient que des couleurs #rrggbb et sert aux pages
--    de connexion (avant toute session). anon n'a aucun droit (règles de lint L4/L11 inchangées) ;
--  * écriture : toute écriture passe par public.set_platform_config / reset_platform_config (SECURITY INVOKER) ->
--    private.* (SECURITY DEFINER, search_path vide), réservées à tout owner / admin ACTIF d'au moins une
--    organisation (private.can_manage_platform_config) : décision du propriétaire du produit (ADR 016) ;
--  * liste blanche de clés et validation de la forme (couleurs #rrggbb minuscules) ; le contraste WCAG est
--    contrôlé par la couche applicative (packages/domain).
-- Risque assumé : la palette est unique pour toute la plateforme ; un owner/admin d'une organisation la modifie pour
-- tous. Le rôle « Platform Admin » de l'ADR 005 §10 (private.platform_admins, J14) reste à construire.
-- Journal d'audit : non branché (table non tenant ; organisation d'accueil des lignes à décider avec la PR J12).

-- ---------------------------------------------------------------------------
-- platform_config
-- ---------------------------------------------------------------------------
create table public.platform_config (
  key text primary key,
  value jsonb not null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_config_key_allowed check (key in ('appearance.palette')),
  constraint platform_config_value_object check (jsonb_typeof(value) = 'object'),
  constraint platform_config_value_size check (octet_length(value::text) <= 16384)
);
comment on table public.platform_config is
  'Paramètres globaux de la plateforme (clé/valeur jsonb, liste blanche). Lecture par get_platform_config, écriture par fonctions réservées aux owner / admin d''organisation.';

create trigger set_updated_at before update on public.platform_config
  for each row execute function private.set_updated_at();

alter table public.platform_config enable row level security;
revoke all on table public.platform_config from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- private.can_manage_platform_config : l'appelant (auth.uid()) est-il owner ou admin ACTIF d'une organisation ?
-- ---------------------------------------------------------------------------
create function private.can_manage_platform_config()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.organization_members m
     where m.user_id = (select auth.uid())
       and m.status = 'active'
       and m.role in ('company_owner', 'company_admin')
  );
$$;

-- ---------------------------------------------------------------------------
-- private.get_platform_config : lecture d'une clé de la liste blanche (null si absente), service_role seulement
-- ---------------------------------------------------------------------------
create function private.get_platform_config(p_key text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select c.value from public.platform_config c where c.key = p_key and p_key = 'appearance.palette';
$$;

-- ---------------------------------------------------------------------------
-- private.is_valid_palette : forme de la palette (aucune dépendance au contraste)
--   {"light": {token: "#rrggbb", ...}, "dark": {...}} ; au moins un mode ; jetons de la liste blanche.
-- ---------------------------------------------------------------------------
create function private.is_valid_palette(p_value jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  c_tokens constant text[] := array[
    'primary', 'primary_foreground', 'secondary', 'secondary_foreground',
    'background', 'foreground', 'accent', 'accent_foreground',
    'destructive', 'destructive_foreground'
  ];
  v_mode record;
  v_tok record;
  v_count integer := 0;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'object' then
    return false;
  end if;
  for v_mode in select * from jsonb_each(p_value) loop
    if v_mode.key not in ('light', 'dark') or jsonb_typeof(v_mode.value) <> 'object' then
      return false;
    end if;
    v_count := v_count + 1;
    for v_tok in select * from jsonb_each(v_mode.value) loop
      if not (v_tok.key = any (c_tokens))
         or jsonb_typeof(v_tok.value) <> 'string'
         or (v_tok.value #>> '{}') !~ '^#[0-9a-f]{6}$' then
        return false;
      end if;
    end loop;
  end loop;
  return v_count >= 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- private.set_platform_config / private.reset_platform_config
-- ---------------------------------------------------------------------------
create function private.set_platform_config(p_key text, p_value jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  -- Autorisation d'abord : rien n'est révélé à un non-habilité.
  if not private.can_manage_platform_config() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_key is distinct from 'appearance.palette' or not private.is_valid_palette(p_value) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;

  insert into public.platform_config (key, value, updated_by)
  values (p_key, p_value, v_uid)
  on conflict (key)
  do update set value = excluded.value, updated_by = excluded.updated_by;
end;
$$;

create function private.reset_platform_config(p_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if not private.can_manage_platform_config() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_key is distinct from 'appearance.palette' then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  delete from public.platform_config where key = p_key;
end;
$$;

revoke all on function private.get_platform_config(text) from public, anon, service_role;
revoke all on function private.can_manage_platform_config() from public, anon, service_role;
revoke all on function private.is_valid_palette(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.set_platform_config(text, jsonb) from public, anon, service_role;
revoke all on function private.reset_platform_config(text) from public, anon, service_role;
grant execute on function private.get_platform_config(text) to service_role;
grant execute on function private.can_manage_platform_config() to authenticated;
grant execute on function private.set_platform_config(text, jsonb) to authenticated;
grant execute on function private.reset_platform_config(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Wrappers publics (SECURITY INVOKER)
-- ---------------------------------------------------------------------------
create function public.get_platform_config(p_key text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.get_platform_config(p_key);
$$;

create function public.can_manage_platform_config()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select private.can_manage_platform_config();
$$;

create function public.set_platform_config(p_key text, p_value jsonb)
returns void
language sql
security invoker
set search_path = ''
as $$
  select private.set_platform_config(p_key, p_value);
$$;

create function public.reset_platform_config(p_key text)
returns void
language sql
security invoker
set search_path = ''
as $$
  select private.reset_platform_config(p_key);
$$;

revoke all on function public.get_platform_config(text) from public, anon, service_role;
revoke all on function public.can_manage_platform_config() from public, anon, service_role;
revoke all on function public.set_platform_config(text, jsonb) from public, anon, service_role;
revoke all on function public.reset_platform_config(text) from public, anon, service_role;
grant execute on function public.get_platform_config(text) to service_role;
grant execute on function public.can_manage_platform_config() to authenticated;
grant execute on function public.set_platform_config(text, jsonb) to authenticated;
grant execute on function public.reset_platform_config(text) to authenticated;
