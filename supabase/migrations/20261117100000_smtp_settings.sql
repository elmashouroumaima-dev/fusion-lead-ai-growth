-- Paramètres SMTP de la plateforme (Paramétrage) et stockage chiffré des secrets (ADR 004, option B).
-- Retour arrière : supabase/rollbacks/20261117100000_smtp_settings.sql
--
-- Décisions (mini-plan validé le 2026-11-07) :
--  * configuration SMTP GLOBALE (non tenant), modifiable par les ADMINISTRATEURS DE LA PLATEFORME seulement
--    (private.platform_admins) : qui change le SMTP global pourrait capter les liens de réinitialisation ;
--  * clé `smtp.settings` de platform_config : hôte, port, sécurité, utilisateur, expéditeur et `secret_id`. Le mot
--    de passe n'est JAMAIS dans cette valeur : il est chiffré par l'application (AES-256-GCM, clé maître dans
--    l'environnement serveur) et seul le chiffré est enregistré dans private.secrets ;
--  * private.secrets : aucun droit pour anon / authenticated / service_role ; accès uniquement par les fonctions
--    ci-dessous (SECURITY DEFINER). Écriture : administrateur de la plateforme ; lecture du chiffré :
--    get_smtp_delivery, réservée à service_role (envoi et test côté serveur) ;
--  * le mot de passe enregistré ne se réutilise pas vers une autre destination : changer l'hôte, le port ou l'utilisateur
--    exige un nouveau mot de passe (`password_required`) ;
--  * aucune API ne renvoie le mot de passe ; la lecture « administrateur » ne donne que `has_password` ;
--  * pas d'écriture dans audit_logs (table tenant : organization_id NOT NULL) : traçabilité par les journaux serveur
--    (ADR 004, mise en œuvre).

-- ---------------------------------------------------------------------------
-- private.secrets (ADR 004)
-- ---------------------------------------------------------------------------
create table private.secrets (
  id uuid primary key,
  purpose text not null,
  organization_id uuid references public.organizations (id) on delete restrict,
  ciphertext text not null,
  nonce text not null,
  key_version integer not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  constraint secrets_purpose_format check (purpose ~ '^[a-z_]{1,32}$'),
  constraint secrets_ciphertext_format check (ciphertext ~ '^[A-Za-z0-9+/]+={0,2}$' and char_length(ciphertext) between 24 and 8192),
  constraint secrets_nonce_format check (nonce ~ '^[A-Za-z0-9+/]{16}$'),
  constraint secrets_key_version_range check (key_version between 1 and 1000)
);
comment on table private.secrets is
  'Secrets chiffrés par l''application (AES-256-GCM, ADR 004). organization_id NULL = secret de la plateforme. Aucun droit d''API.';
revoke all on table private.secrets from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- platform_config : clé smtp.settings autorisée (lecture/écriture uniquement par les fonctions ci-dessous)
-- ---------------------------------------------------------------------------
alter table public.platform_config drop constraint platform_config_key_allowed;
alter table public.platform_config
  add constraint platform_config_key_allowed check (key in ('appearance.palette', 'appearance.logo', 'smtp.settings'));

-- ---------------------------------------------------------------------------
-- private.is_valid_smtp_settings : forme des paramètres (hors secret_id, ajouté par la fonction d'écriture)
-- ---------------------------------------------------------------------------
create function private.is_valid_smtp_settings(p_value jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
  v_port numeric;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'object' then
    return false;
  end if;
  for v_key in select jsonb_object_keys(p_value) loop
    if v_key not in ('host', 'port', 'security', 'username', 'from_email', 'from_name') then
      return false;
    end if;
  end loop;
  if not (p_value ? 'host' and p_value ? 'port' and p_value ? 'security' and p_value ? 'from_email') then
    return false;
  end if;
  if jsonb_typeof(p_value -> 'host') <> 'string'
     or (p_value ->> 'host') !~ '^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$'
     or char_length(p_value ->> 'host') > 253 then
    return false;
  end if;
  if jsonb_typeof(p_value -> 'port') <> 'number' or (p_value ->> 'port') !~ '^[0-9]{1,5}$' then
    return false;
  end if;
  v_port := (p_value ->> 'port')::numeric;
  if v_port < 1 or v_port > 65535 then
    return false;
  end if;
  if jsonb_typeof(p_value -> 'security') <> 'string' or (p_value ->> 'security') not in ('tls', 'starttls', 'none') then
    return false;
  end if;
  if p_value ? 'username' and (
       jsonb_typeof(p_value -> 'username') <> 'string'
       or char_length(p_value ->> 'username') not between 1 and 255
       or (p_value ->> 'username') ~ '[[:cntrl:]\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff\U000e0000-\U000e007f]') then
    return false;
  end if;
  if jsonb_typeof(p_value -> 'from_email') <> 'string'
     or (p_value ->> 'from_email') !~ '^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$'
     or char_length(p_value ->> 'from_email') > 254 then
    return false;
  end if;
  if p_value ? 'from_name' and (
       jsonb_typeof(p_value -> 'from_name') <> 'string'
       or char_length(p_value ->> 'from_name') not between 1 and 100
       or (p_value ->> 'from_name') ~ '[[:cntrl:]\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff\U000e0000-\U000e007f]') then
    return false;
  end if;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- private.set_smtp_settings : administrateur de la plateforme. Mot de passe facultatif (déjà chiffré côté serveur).
-- ---------------------------------------------------------------------------
create function private.set_smtp_settings(
  p_settings jsonb,
  p_secret_id uuid,
  p_ciphertext text,
  p_nonce text,
  p_key_version integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_secret uuid;
  v_new_secret uuid;
  v_old public.platform_config%rowtype;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if not private.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not private.is_valid_smtp_settings(p_settings) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  -- Sérialise les écritures concurrentes (pas de secret orphelin).
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended('smtp.settings', 0));

  select * into v_old from public.platform_config c where c.key = 'smtp.settings';
  v_old_secret := nullif(v_old.value ->> 'secret_id', '')::uuid;
  v_new_secret := v_old_secret;

  -- Le mot de passe enregistré ne peut pas être « réutilisé » vers une autre destination : si l'hôte, le port ou
  -- l'utilisateur changent, un NOUVEAU mot de passe est obligatoire (sinon un administrateur pourrait faire envoyer
  -- l'ancien mot de passe, déchiffré par le test d'envoi, vers un serveur de son choix).
  if p_ciphertext is null and v_old_secret is not null and (
       (v_old.value -> 'host') is distinct from (p_settings -> 'host')
       or (v_old.value -> 'port') is distinct from (p_settings -> 'port')
       or (v_old.value -> 'username') is distinct from (p_settings -> 'username')) then
    raise exception 'password_required' using errcode = '22023';
  end if;

  if p_ciphertext is not null then
    if p_secret_id is null or p_nonce is null or p_key_version is null then
      raise exception 'validation_failed' using errcode = '22023';
    end if;
    insert into private.secrets (id, purpose, organization_id, ciphertext, nonce, key_version)
    values (p_secret_id, 'smtp', null, p_ciphertext, p_nonce, p_key_version);
    v_new_secret := p_secret_id;
  elsif p_secret_id is not null or p_nonce is not null or p_key_version is not null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;

  insert into public.platform_config (key, value, updated_by)
  values ('smtp.settings',
          p_settings || case when v_new_secret is null then '{}'::jsonb else jsonb_build_object('secret_id', v_new_secret) end,
          auth.uid())
  on conflict (key)
  do update set value = excluded.value, updated_by = excluded.updated_by;

  if v_old_secret is not null and v_old_secret is distinct from v_new_secret then
    delete from private.secrets where id = v_old_secret and purpose = 'smtp';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- private.reset_smtp_settings : supprime la configuration et le secret
-- ---------------------------------------------------------------------------
create function private.reset_smtp_settings()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret uuid;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if not private.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended('smtp.settings', 0));
  select nullif(c.value ->> 'secret_id', '')::uuid into v_secret from public.platform_config c where c.key = 'smtp.settings';
  delete from public.platform_config where key = 'smtp.settings';
  if v_secret is not null then
    delete from private.secrets where id = v_secret and purpose = 'smtp';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- private.get_smtp_settings : administrateur de la plateforme. Jamais le secret : seulement has_password.
-- ---------------------------------------------------------------------------
create function private.get_smtp_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_value jsonb;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if not private.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select c.value into v_value from public.platform_config c where c.key = 'smtp.settings';
  if v_value is null then
    return null;
  end if;
  return (v_value - 'secret_id') || jsonb_build_object('has_password', (v_value ->> 'secret_id') is not null);
end;
$$;

-- ---------------------------------------------------------------------------
-- private.get_smtp_delivery : service_role (envoi et test côté serveur). Paramètres + secret CHIFFRÉ.
-- ---------------------------------------------------------------------------
create function private.get_smtp_delivery()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_value jsonb;
  v_secret private.secrets%rowtype;
begin
  select c.value into v_value from public.platform_config c where c.key = 'smtp.settings';
  if v_value is null then
    return null;
  end if;
  if (v_value ->> 'secret_id') is not null then
    select s.* into v_secret from private.secrets s where s.id = (v_value ->> 'secret_id')::uuid and s.purpose = 'smtp';
  end if;
  return (v_value - 'secret_id') || jsonb_build_object(
    'secret', case when v_secret.id is null then null else jsonb_build_object(
      'id', v_secret.id, 'ciphertext', v_secret.ciphertext, 'nonce', v_secret.nonce, 'key_version', v_secret.key_version) end);
end;
$$;

-- ---------------------------------------------------------------------------
-- Droits
-- ---------------------------------------------------------------------------
revoke all on function private.is_valid_smtp_settings(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.set_smtp_settings(jsonb, uuid, text, text, integer) from public, anon, service_role;
revoke all on function private.reset_smtp_settings() from public, anon, service_role;
revoke all on function private.get_smtp_settings() from public, anon, service_role;
revoke all on function private.get_smtp_delivery() from public, anon, authenticated, service_role;
grant execute on function private.set_smtp_settings(jsonb, uuid, text, text, integer) to authenticated;
grant execute on function private.reset_smtp_settings() to authenticated;
grant execute on function private.get_smtp_settings() to authenticated;
grant execute on function private.get_smtp_delivery() to service_role;

create function public.set_smtp_settings(p_settings jsonb, p_secret_id uuid, p_ciphertext text, p_nonce text, p_key_version integer)
returns void language sql security invoker set search_path = ''
as $$ select private.set_smtp_settings(p_settings, p_secret_id, p_ciphertext, p_nonce, p_key_version); $$;
create function public.reset_smtp_settings()
returns void language sql security invoker set search_path = ''
as $$ select private.reset_smtp_settings(); $$;
create function public.get_smtp_settings()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.get_smtp_settings(); $$;
create function public.get_smtp_delivery()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.get_smtp_delivery(); $$;

revoke all on function public.set_smtp_settings(jsonb, uuid, text, text, integer) from public, anon, service_role;
revoke all on function public.reset_smtp_settings() from public, anon, service_role;
revoke all on function public.get_smtp_settings() from public, anon, service_role;
revoke all on function public.get_smtp_delivery() from public, anon, authenticated, service_role;
grant execute on function public.set_smtp_settings(jsonb, uuid, text, text, integer) to authenticated;
grant execute on function public.reset_smtp_settings() to authenticated;
grant execute on function public.get_smtp_settings() to authenticated;
grant execute on function public.get_smtp_delivery() to service_role;
