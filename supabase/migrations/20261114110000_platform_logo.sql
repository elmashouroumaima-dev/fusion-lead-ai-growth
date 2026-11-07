-- J12b — logo de la plateforme dans platform_config (clé `appearance.logo`). ADR 016 (Proposed).
-- Retour arrière : supabase/rollbacks/20261114110000_platform_logo.sql
-- (nouvelle migration : 20261114100000 est déjà publiée dans la PR #9, on ne la modifie pas.)
--
-- Valeur : {"mime": "image/png" | "image/jpeg" | "image/webp", "data": "<base64>"}.
--  * SVG refusé (peut porter du script) ; seuls PNG / JPEG / WebP, reconnus par leurs octets de signature
--    (et non par le seul `mime` annoncé) ;
--  * taille décodée ≤ 128 Ko (131072 octets) ; la palette reste limitée à 16 Ko ;
--  * mêmes droits que la palette : écriture owner/admin actif d'une organisation, lecture serveur (service_role).

-- ---------------------------------------------------------------------------
-- Contraintes : liste blanche de clés et tailles par clé
-- ---------------------------------------------------------------------------
alter table public.platform_config drop constraint platform_config_key_allowed;
alter table public.platform_config drop constraint platform_config_value_size;
alter table public.platform_config
  add constraint platform_config_key_allowed check (key in ('appearance.palette', 'appearance.logo'));
alter table public.platform_config
  add constraint platform_config_value_size check (
    octet_length(value::text) <= case when key = 'appearance.logo' then 200000 else 16384 end
  );

-- ---------------------------------------------------------------------------
-- private.is_valid_logo : forme, base64, taille décodée et signature de l'image
-- ---------------------------------------------------------------------------
create function private.is_valid_logo(p_value jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  c_max_bytes constant integer := 131072;
  v_mime text;
  v_data text;
  v_bytes bytea;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'object' then
    return false;
  end if;
  -- Exactement deux clés : mime et data.
  if (select count(*) from jsonb_object_keys(p_value)) <> 2
     or not (p_value ? 'mime') or not (p_value ? 'data')
     or jsonb_typeof(p_value -> 'mime') <> 'string' or jsonb_typeof(p_value -> 'data') <> 'string' then
    return false;
  end if;
  v_mime := p_value ->> 'mime';
  v_data := p_value ->> 'data';
  if v_mime not in ('image/png', 'image/jpeg', 'image/webp') then
    return false;
  end if;
  -- Base64 strict (sans retour à la ligne) ; la longueur plafonne la taille avant tout décodage.
  if char_length(v_data) < 8 or char_length(v_data) > 174764 or v_data !~ '^[A-Za-z0-9+/]+={0,2}$' or char_length(v_data) % 4 <> 0 then
    return false;
  end if;
  v_bytes := decode(v_data, 'base64');
  if length(v_bytes) > c_max_bytes then
    return false;
  end if;
  -- Signature : PNG 89 50 4E 47 0D 0A 1A 0A · JPEG FF D8 FF · WebP « RIFF » .... « WEBP ».
  if v_mime = 'image/png' then
    return substring(v_bytes from 1 for 8) = '\x89504e470d0a1a0a'::bytea;
  elsif v_mime = 'image/jpeg' then
    return substring(v_bytes from 1 for 3) = '\xffd8ff'::bytea;
  else
    return substring(v_bytes from 1 for 4) = '\x52494646'::bytea
       and substring(v_bytes from 9 for 4) = '\x57454250'::bytea;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fonctions d'accès : clés autorisées étendues au logo
-- ---------------------------------------------------------------------------
create or replace function private.get_platform_config(p_key text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select c.value from public.platform_config c where c.key = p_key and p_key in ('appearance.palette', 'appearance.logo');
$$;

-- Date de dernière modification d'une clé (sert à versionner l'URL du logo sans lire le logo à chaque page).
create function private.get_platform_config_updated_at(p_key text)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select c.updated_at from public.platform_config c where c.key = p_key and p_key in ('appearance.palette', 'appearance.logo');
$$;

create or replace function private.set_platform_config(p_key text, p_value jsonb)
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
  if not (
       (p_key = 'appearance.palette' and private.is_valid_palette(p_value))
    or (p_key = 'appearance.logo' and private.is_valid_logo(p_value))
  ) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;

  insert into public.platform_config (key, value, updated_by)
  values (p_key, p_value, v_uid)
  on conflict (key)
  do update set value = excluded.value, updated_by = excluded.updated_by;
end;
$$;

create or replace function private.reset_platform_config(p_key text)
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
  if p_key is null or p_key not in ('appearance.palette', 'appearance.logo') then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  delete from public.platform_config where key = p_key;
end;
$$;

create function public.get_platform_config_updated_at(p_key text)
returns timestamptz
language sql
stable
security invoker
set search_path = ''
as $$
  select private.get_platform_config_updated_at(p_key);
$$;

revoke all on function private.is_valid_logo(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.get_platform_config_updated_at(text) from public, anon, authenticated;
revoke all on function public.get_platform_config_updated_at(text) from public, anon, authenticated;
grant execute on function private.get_platform_config_updated_at(text) to service_role;
grant execute on function public.get_platform_config_updated_at(text) to service_role;
