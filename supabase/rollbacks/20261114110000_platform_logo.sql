-- Retour arrière de 20261114110000_platform_logo.sql (à exécuter AVANT celui de 20261114100000).
-- ATTENTION : supprime le logo enregistré ; exporter avant si besoin.

delete from public.platform_config where key = 'appearance.logo';

drop function if exists public.get_platform_config_updated_at(text);
drop function if exists private.get_platform_config_updated_at(text);
drop function if exists private.is_valid_logo(jsonb);

alter table public.platform_config drop constraint platform_config_value_size;
alter table public.platform_config drop constraint platform_config_key_allowed;
alter table public.platform_config add constraint platform_config_key_allowed check (key in ('appearance.palette'));
alter table public.platform_config add constraint platform_config_value_size check (octet_length(value::text) <= 16384);

create or replace function private.get_platform_config(p_key text)
returns jsonb language sql stable security definer set search_path = ''
as $$ select c.value from public.platform_config c where c.key = p_key and p_key = 'appearance.palette'; $$;

create or replace function private.set_platform_config(p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'unauthenticated' using errcode = '28000'; end if;
  if not private.can_manage_platform_config() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_key is distinct from 'appearance.palette' or not private.is_valid_palette(p_value) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  insert into public.platform_config (key, value, updated_by) values (p_key, p_value, v_uid)
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;
end;
$$;

create or replace function private.reset_platform_config(p_key text)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'unauthenticated' using errcode = '28000'; end if;
  if not private.can_manage_platform_config() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_key is distinct from 'appearance.palette' then raise exception 'validation_failed' using errcode = '22023'; end if;
  delete from public.platform_config where key = p_key;
end;
$$;
