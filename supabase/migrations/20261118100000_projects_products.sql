-- J16 — Projets et produits (spec §4, §7, §8 ; ADR 005 FK composites ; ADR 007 ; ADR 014).
-- Retour arrière : supabase/rollbacks/20261118100000_projects_products.sql
--
-- Décisions (mini-plan validé le 2026-11-08) :
--  * project_type : website_sales, salla_app, salla_theme, custom (spec §4) ; project_status : active, archived ;
--  * projects.settings (jsonb) : la FORME par type est validée par zod côté application (spec §7 « schéma zod par
--    type ») ; la base impose seulement un objet de 32 Ko au plus ;
--  * ÉCRITURE UNIQUEMENT PAR FONCTIONS (SECURITY DEFINER, identité = auth.uid()) : owner et admin d'organisation
--    (matrice ADR 014 : créer, modifier, archiver). Aucun droit INSERT / UPDATE / DELETE direct, même pour
--    service_role : le quota « projects » ne peut pas être contourné (y compris par réactivation d'un projet archivé) ;
--  * lecture : tous les rôles actifs de l'entreprise ; aucune suppression (l'archivage remplace DELETE : écart
--    assumé avec la ligne « delete » de l'ADR 007, alignée sur la matrice ADR 014) ;
--  * quota « projects » = projets ACTIFS (un projet archivé ne compte pas) ; contrôle sous verrou consultatif ;
--  * owner_id : FK composite vers une adhésion de la MÊME entreprise ; doit être active à l'écriture ; NULL si
--    l'adhésion est supprimée ;
--  * products : FK composite vers projects ; products.assets = chemins Storage, obligatoirement sous
--    `{organization_id}/{project_id}/` (aucune référence possible vers les fichiers d'une autre entreprise) ;
--    landing_url : https uniquement, sans identifiants intégrés ;
--  * revue sécurité adverse (2026-11-08) : liste de caractères invisibles et de direction étendue ; URL = nom de domaine
--    seulement (ni IP, ni « localhost », ni hôte interne, port 1 à 65535) ; réglages : clés autorisées par type, liens
--    https, 4 niveaux au plus (appel direct de la fonction possible : la base ne dépend plus de zod pour cela) ; plafond
--    technique de 100 produits par projet ; `update_project` exige `p_owner` (plus d'effacement silencieux) ; `not_found`
--    en SQLSTATE PT404 (HTTP 404) ; un membre suspendu ou retiré perd ses projets (owner_id NULL) ;
--  * un produit n'a pas de statut dans la spec : pas d'archivage de produit au J16 (point soumis à la responsable
--    technique) ; un projet archivé est en lecture seule (ses produits aussi).

create type public.project_type as enum ('website_sales', 'salla_app', 'salla_theme', 'custom');
create type public.project_status as enum ('active', 'archived');

-- ---------------------------------------------------------------------------
-- Validations (fonctions pures, search_path vide)
-- ---------------------------------------------------------------------------
-- Texte sûr : longueur bornée, sans espaces en bordure, sans caractère de contrôle, de direction, séparateur de ligne,
-- BOM ni caractère de balise. `p_multiline` autorise les retours à la ligne et tabulations.
create function private.is_safe_text(p_value text, p_min integer, p_max integer, p_multiline boolean default false)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_value is not null
     and char_length(p_value) between p_min and p_max
     -- ni espace (ni saut de ligne, ni espace insécable) en bordure
     and p_value !~ '^[[:space:]\u00a0\u2000-\u200a\u202f\u205f\u3000]|[[:space:]\u00a0\u2000-\u200a\u202f\u205f\u3000]$'
     and p_value !~ case
           when p_multiline
             then '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u00ad\u034f\u061c\u115f\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\ufff9-\ufffc\U000e0000-\U000e007f\U000e0100-\U000e01ef]'
           else '[[:cntrl:]\u00ad\u034f\u061c\u115f\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\ufff9-\ufffc\U000e0000-\U000e007f\U000e0100-\U000e01ef]'
         end;
$$;

-- URL de page d'atterrissage : https, hôte sans identifiants, 2048 caractères au plus.
create function private.is_safe_https_url(p_value text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_value is not null
     and char_length(p_value) <= 2048
     -- https ; nom de domaine (étiquettes, extension alphabétique) : ni adresse IP, ni « localhost », ni identifiants ;
     -- port 1 à 65535 ; chemin sans espace, contrôle, caractère dangereux ni caractère invisible ou de direction
     and p_value ~ ('(?i)^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}'
                    || '(:([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?'
                    || '(/[^[:space:][:cntrl:]<>"\\^`{|}\u00ad\u034f\u061c\u115f\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\ufff9-\ufffc\U000e0000-\U000e007f\U000e0100-\U000e01ef]*)?$')
     -- noms réservés aux réseaux internes
     and p_value !~ '(?i)^https://[^/:?#]*\.(local|localhost|internal|lan|intranet|corp|home|test\.local)(:|/|\?|#|$)';
$$;

-- Profondeur d'un document JSON (un scalaire = 0).
create function private.jsonb_depth(p_value jsonb)
returns integer
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_child jsonb;
  v_max integer := 0;
  v_depth integer;
begin
  if pg_catalog.jsonb_typeof(p_value) = 'object' then
    for v_child in select e.value from pg_catalog.jsonb_each(p_value) as e loop
      v_depth := private.jsonb_depth(v_child);
      if v_depth > v_max then v_max := v_depth; end if;
    end loop;
    return v_max + 1;
  elsif pg_catalog.jsonb_typeof(p_value) = 'array' then
    for v_child in select e from pg_catalog.jsonb_array_elements(p_value) as e loop
      v_depth := private.jsonb_depth(v_child);
      if v_depth > v_max then v_max := v_depth; end if;
    end loop;
    return v_max + 1;
  end if;
  return 0;
end;
$$;

-- Réglages d'un projet : objet JSON de 32 Ko au plus, 4 niveaux au plus, clés de premier niveau limitées à celles du type
-- (spec §4), liens en https valides. La forme fine (longueurs, listes) est contrôlée par zod.
create function private.is_valid_project_settings(p_type public.project_type, p_settings jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_allowed text[];
  v_key text;
  v_page jsonb;
begin
  if p_settings is null or pg_catalog.jsonb_typeof(p_settings) <> 'object'
     or pg_catalog.octet_length(p_settings::text) > 32768
     or private.jsonb_depth(p_settings) > 4 then
    return false;
  end if;
  v_allowed := case p_type
    when 'website_sales' then array['offers', 'business_models', 'target_market', 'qualification_questions', 'landing_pages']
    when 'salla_app' then array['app_name', 'problem_solved', 'merchant_segments', 'store_url', 'activation_flow', 'test_pricing', 'faqs']
    when 'salla_theme' then array['preview_url', 'sectors', 'features', 'ad_scenarios']
    else array['notes', 'fields']
  end;
  for v_key in select k from pg_catalog.jsonb_object_keys(p_settings) as k loop
    if not (v_key = any (v_allowed)) then
      return false;
    end if;
  end loop;
  -- Liens : https valides (jamais « javascript: », adresse IP ni hôte interne).
  foreach v_key in array array['store_url', 'preview_url'] loop
    if p_settings ? v_key and (pg_catalog.jsonb_typeof(p_settings -> v_key) <> 'string'
       or not private.is_safe_https_url(p_settings ->> v_key)) then
      return false;
    end if;
  end loop;
  if p_settings ? 'landing_pages' then
    if pg_catalog.jsonb_typeof(p_settings -> 'landing_pages') <> 'array' then
      return false;
    end if;
    for v_page in select e from pg_catalog.jsonb_array_elements(p_settings -> 'landing_pages') as e loop
      if pg_catalog.jsonb_typeof(v_page) <> 'object' or pg_catalog.jsonb_typeof(v_page -> 'url') is distinct from 'string'
         or not private.is_safe_https_url(v_page ->> 'url') then
        return false;
      end if;
    end loop;
  end if;
  return true;
end;
$$;

-- Assets d'un produit : tableau de 50 chemins au plus, chacun sous `{organisation}/{projet}/`.
create function private.is_valid_product_assets(p_org uuid, p_project uuid, p_assets jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_element jsonb;
  v_prefix text;
begin
  if p_assets is null or pg_catalog.jsonb_typeof(p_assets) <> 'array' or pg_catalog.jsonb_array_length(p_assets) > 50 then
    return false;
  end if;
  v_prefix := p_org::text || '/' || p_project::text || '/';
  for v_element in select e from pg_catalog.jsonb_array_elements(p_assets) as e loop
    if pg_catalog.jsonb_typeof(v_element) <> 'string'
       or (v_element #>> '{}') !~ ('^' || v_prefix || '[A-Za-z0-9._/-]{1,200}$')
       or (v_element #>> '{}') ~ '\.\.|//' then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  type public.project_type not null,
  name text not null,
  status public.project_status not null default 'active',
  owner_id uuid,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_org_id_key unique (organization_id, id),
  -- propriétaire = membre de la même entreprise ; si l'adhésion est supprimée, seule owner_id passe à NULL
  constraint projects_owner_fkey foreign key (organization_id, owner_id)
    references public.organization_members (organization_id, user_id) on delete set null (owner_id),
  constraint projects_name_valid check (private.is_safe_text(name, 1, 120)),
  constraint projects_settings_valid check (private.is_valid_project_settings(type, settings))
);
create index projects_org_status_idx on public.projects (organization_id, status);
comment on table public.projects is 'Projets d''une entreprise (spec §7). Écriture par fonctions uniquement (quota « projects »).';

create table public.products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  project_id uuid not null,
  kind text not null,
  offer text not null,
  price_hint text,
  landing_url text,
  assets jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_org_id_key unique (organization_id, id),
  constraint products_project_fkey foreign key (organization_id, project_id)
    references public.projects (organization_id, id) on delete restrict,
  constraint products_kind_valid check (private.is_safe_text(kind, 1, 50)),
  constraint products_offer_valid check (private.is_safe_text(offer, 1, 500, true)),
  constraint products_price_hint_valid check (price_hint is null or private.is_safe_text(price_hint, 1, 100)),
  constraint products_landing_url_valid check (landing_url is null or private.is_safe_https_url(landing_url)),
  constraint products_assets_valid check (private.is_valid_product_assets(organization_id, project_id, assets))
);
create index products_org_project_idx on public.products (organization_id, project_id);
comment on table public.products is 'Produits et offres d''un projet (spec §7). FK composite : même entreprise que le projet.';

-- ---------------------------------------------------------------------------
-- Triggers : updated_at, immutabilité de l'entreprise, du type et du projet
-- ---------------------------------------------------------------------------
create function private.projects_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.type is distinct from old.type then
    raise exception 'project type is immutable' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create function private.products_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.project_id is distinct from old.project_id then
    raise exception 'product project is immutable' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger projects_set_updated_at before update on public.projects
  for each row execute function private.set_updated_at();
create trigger projects_org_immutable before update on public.projects
  for each row execute function private.prevent_organization_id_change();
create trigger projects_type_immutable before update on public.projects
  for each row execute function private.projects_immutable();
create trigger products_set_updated_at before update on public.products
  for each row execute function private.set_updated_at();
create trigger products_org_immutable before update on public.products
  for each row execute function private.prevent_organization_id_change();
create trigger products_project_immutable before update on public.products
  for each row execute function private.products_immutable();

-- ---------------------------------------------------------------------------
-- Audit (project.created / updated / archived / reactivated ; product.created / updated)
-- Seuls des identifiants, le type, le nom et les NOMS des champs modifiés sont journalisés (pas le contenu des offres).
-- ---------------------------------------------------------------------------
create function private.audit_projects()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed text[] := '{}';
begin
  if tg_op = 'INSERT' then
    perform private.audit_write(
      new.organization_id, 'project.created', 'project', new.id, null,
      pg_catalog.jsonb_build_object('type', new.type, 'name', new.name, 'status', new.status, 'owner_id', new.owner_id));
    return null;
  end if;

  if new.status is distinct from old.status then
    perform private.audit_write(
      new.organization_id,
      case when new.status = 'archived' then 'project.archived' else 'project.reactivated' end,
      'project', new.id,
      pg_catalog.jsonb_build_object('status', old.status),
      pg_catalog.jsonb_build_object('status', new.status));
  end if;

  if new.name is distinct from old.name then v_changed := pg_catalog.array_append(v_changed, 'name'::text); end if;
  if new.owner_id is distinct from old.owner_id then v_changed := pg_catalog.array_append(v_changed, 'owner_id'::text); end if;
  if new.settings is distinct from old.settings then v_changed := pg_catalog.array_append(v_changed, 'settings'::text); end if;
  if pg_catalog.cardinality(v_changed) > 0 then
    perform private.audit_write(
      new.organization_id, 'project.updated', 'project', new.id,
      pg_catalog.jsonb_build_object('name', old.name, 'owner_id', old.owner_id),
      pg_catalog.jsonb_build_object('name', new.name, 'owner_id', new.owner_id, 'changed', v_changed));
  end if;
  return null;
end;
$$;

create function private.audit_products()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed text[] := '{}';
begin
  if tg_op = 'INSERT' then
    perform private.audit_write(
      new.organization_id, 'product.created', 'product', new.id, null,
      pg_catalog.jsonb_build_object('project_id', new.project_id, 'kind', new.kind));
    return null;
  end if;

  if new.kind is distinct from old.kind then v_changed := pg_catalog.array_append(v_changed, 'kind'::text); end if;
  if new.offer is distinct from old.offer then v_changed := pg_catalog.array_append(v_changed, 'offer'::text); end if;
  if new.price_hint is distinct from old.price_hint then v_changed := pg_catalog.array_append(v_changed, 'price_hint'::text); end if;
  if new.landing_url is distinct from old.landing_url then v_changed := pg_catalog.array_append(v_changed, 'landing_url'::text); end if;
  if new.assets is distinct from old.assets then v_changed := pg_catalog.array_append(v_changed, 'assets'::text); end if;
  if pg_catalog.cardinality(v_changed) > 0 then
    perform private.audit_write(
      new.organization_id, 'product.updated', 'product', new.id,
      pg_catalog.jsonb_build_object('project_id', old.project_id, 'kind', old.kind),
      pg_catalog.jsonb_build_object('project_id', new.project_id, 'kind', new.kind, 'changed', v_changed));
  end if;
  return null;
end;
$$;

create trigger audit_projects after insert or update on public.projects
  for each row execute function private.audit_projects();
create trigger audit_products after insert or update on public.products
  for each row execute function private.audit_products();

-- Un membre suspendu ou retiré n'est plus propriétaire d'aucun projet (owner_id -> NULL ; audit project.updated).
create function private.release_project_ownership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.projects set owner_id = null
   where organization_id = new.organization_id and owner_id = new.user_id;
  return null;
end;
$$;
create trigger release_project_ownership
  after update of status on public.organization_members
  for each row
  when (old.status = 'active' and new.status is distinct from 'active')
  execute function private.release_project_ownership();

-- ---------------------------------------------------------------------------
-- RLS : lecture par tous les rôles actifs de l'entreprise ; aucune écriture directe
-- ---------------------------------------------------------------------------
alter table public.projects enable row level security;
alter table public.products enable row level security;

grant select on table public.projects to authenticated;
grant select on table public.products to authenticated;
-- Toute écriture passe par les fonctions ci-dessous (quota) : pas d'écriture directe, même pour service_role.
revoke insert, update, delete, truncate on table public.projects from service_role;
revoke insert, update, delete, truncate on table public.products from service_role;

create policy projects_select on public.projects
  for select to authenticated
  using (private.is_member(organization_id));

create policy products_select on public.products
  for select to authenticated
  using (private.is_member(organization_id));

-- ---------------------------------------------------------------------------
-- Quota « projects » : projets actifs (remplace la version du J14 qui renvoyait 0)
-- ---------------------------------------------------------------------------
create or replace function private.current_stock_usage(p_org uuid, p_metric text)
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_metric = 'users' then
    return (select count(*) from public.organization_members m where m.organization_id = p_org and m.status = 'active')
         + (select count(*) from public.invitations i
             where i.organization_id = p_org and i.accepted_at is null and i.revoked_at is null and i.expires_at > now());
  end if;
  if p_metric = 'projects' then
    return (select count(*) from public.projects p where p.organization_id = p_org and p.status = 'active');
  end if;
  -- contacts, integrations : tables créées par leurs modules (J18 et suivants).
  return 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fonctions d'écriture (SECURITY DEFINER ; identité = auth.uid() ; owner / admin actifs)
-- Codes d'erreur : unauthenticated 28000 · forbidden 42501 · validation_failed 22023 · not_found PT404 ·
-- project_archived P0001 · owner_invalid P0001 · quota_exceeded P0001 (detail = projects) · subscription_inactive P0001.
-- ---------------------------------------------------------------------------
create function private.assert_project_manager(p_org uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '28000';
  end if;
  if p_org is null or not private.has_role(p_org, array['company_owner', 'company_admin']::public.app_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end;
$$;

create function private.create_project(
  p_org uuid, p_type public.project_type, p_name text, p_settings jsonb, p_owner uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.assert_project_manager(p_org);
  if p_type is null or not private.is_safe_text(p_name, 1, 120) or not private.is_valid_project_settings(p_type, p_settings) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  if p_owner is not null and not exists (
    select 1 from public.organization_members m
     where m.organization_id = p_org and m.user_id = p_owner and m.status = 'active'
  ) then
    raise exception 'owner_invalid' using errcode = 'P0001';
  end if;

  -- Contrôle du quota (verrou consultatif de l'organisation) et insertion dans la même transaction.
  perform private.assert_within_limit(p_org, 'projects', 1);

  insert into public.projects (organization_id, type, name, owner_id, settings)
  values (p_org, p_type, p_name, p_owner, p_settings)
  returning id into v_id;
  return v_id;
end;
$$;

create function private.update_project(
  p_org uuid, p_id uuid, p_name text, p_settings jsonb, p_owner uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.project_status;
  v_type public.project_type;
begin
  perform private.assert_project_manager(p_org);
  if p_id is null or not private.is_safe_text(p_name, 1, 120) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;

  select p.status, p.type into v_status, v_type from public.projects p
   where p.id = p_id and p.organization_id = p_org for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if v_status = 'archived' then
    raise exception 'project_archived' using errcode = 'P0001';
  end if;
  if not private.is_valid_project_settings(v_type, p_settings) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  if p_owner is not null and not exists (
    select 1 from public.organization_members m
     where m.organization_id = p_org and m.user_id = p_owner and m.status = 'active'
  ) then
    raise exception 'owner_invalid' using errcode = 'P0001';
  end if;

  update public.projects set name = p_name, settings = p_settings, owner_id = p_owner
   where id = p_id and organization_id = p_org;
end;
$$;

-- Archive ou réactive un projet. La réactivation consomme de nouveau le quota (un projet archivé ne compte pas).
create function private.set_project_status(p_org uuid, p_id uuid, p_status public.project_status)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.project_status;
begin
  perform private.assert_project_manager(p_org);
  if p_id is null or p_status is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;

  select p.status into v_status from public.projects p
   where p.id = p_id and p.organization_id = p_org for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if v_status = p_status then
    return;
  end if;
  if p_status = 'active' then
    perform private.assert_within_limit(p_org, 'projects', 1);
  end if;
  update public.projects set status = p_status where id = p_id and organization_id = p_org;
end;
$$;

create function private.create_product(
  p_org uuid, p_project uuid, p_kind text, p_offer text, p_price_hint text, p_landing_url text, p_assets jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.project_status;
  v_id uuid := gen_random_uuid();
begin
  perform private.assert_project_manager(p_org);
  if p_project is null
     or not private.is_safe_text(p_kind, 1, 50)
     or not private.is_safe_text(p_offer, 1, 500, true)
     or (p_price_hint is not null and not private.is_safe_text(p_price_hint, 1, 100))
     or (p_landing_url is not null and not private.is_safe_https_url(p_landing_url))
     or not private.is_valid_product_assets(p_org, p_project, coalesce(p_assets, '[]'::jsonb)) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;

  select p.status into v_status from public.projects p
   where p.id = p_project and p.organization_id = p_org for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if v_status = 'archived' then
    raise exception 'project_archived' using errcode = 'P0001';
  end if;
  -- Plafond technique (hors plan, provisoire) : le verrou du projet sérialise les créations concurrentes.
  if (select count(*) from public.products pr where pr.organization_id = p_org and pr.project_id = p_project) >= 100 then
    raise exception 'quota_exceeded' using errcode = 'P0001', detail = 'products';
  end if;

  insert into public.products (id, organization_id, project_id, kind, offer, price_hint, landing_url, assets)
  values (v_id, p_org, p_project, p_kind, p_offer, p_price_hint, p_landing_url, coalesce(p_assets, '[]'::jsonb));
  return v_id;
end;
$$;

create function private.update_product(
  p_org uuid, p_id uuid, p_kind text, p_offer text, p_price_hint text, p_landing_url text, p_assets jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_status public.project_status;
begin
  perform private.assert_project_manager(p_org);
  if p_id is null
     or not private.is_safe_text(p_kind, 1, 50)
     or not private.is_safe_text(p_offer, 1, 500, true)
     or (p_price_hint is not null and not private.is_safe_text(p_price_hint, 1, 100))
     or (p_landing_url is not null and not private.is_safe_https_url(p_landing_url)) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;

  select pr.project_id into v_project from public.products pr
   where pr.id = p_id and pr.organization_id = p_org for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if not private.is_valid_product_assets(p_org, v_project, coalesce(p_assets, '[]'::jsonb)) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select p.status into v_status from public.projects p where p.id = v_project and p.organization_id = p_org;
  if v_status = 'archived' then
    raise exception 'project_archived' using errcode = 'P0001';
  end if;

  update public.products
     set kind = p_kind, offer = p_offer, price_hint = p_price_hint, landing_url = p_landing_url,
         assets = coalesce(p_assets, '[]'::jsonb)
   where id = p_id and organization_id = p_org;
end;
$$;

-- ---------------------------------------------------------------------------
-- Droits sur les fonctions privées : exécutables par authenticated (appelées par les enveloppes SECURITY INVOKER)
-- ---------------------------------------------------------------------------
revoke all on function private.is_safe_text(text, integer, integer, boolean) from public, anon, authenticated, service_role;
revoke all on function private.is_safe_https_url(text) from public, anon, authenticated, service_role;
revoke all on function private.is_valid_project_settings(public.project_type, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.jsonb_depth(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.release_project_ownership() from public, anon, authenticated, service_role;
revoke all on function private.is_valid_product_assets(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.projects_immutable() from public, anon, authenticated, service_role;
revoke all on function private.products_immutable() from public, anon, authenticated, service_role;
revoke all on function private.audit_projects() from public, anon, authenticated, service_role;
revoke all on function private.audit_products() from public, anon, authenticated, service_role;
revoke all on function private.assert_project_manager(uuid) from public, anon, authenticated, service_role;
revoke all on function private.create_project(uuid, public.project_type, text, jsonb, uuid) from public, anon, authenticated, service_role;
revoke all on function private.update_project(uuid, uuid, text, jsonb, uuid) from public, anon, authenticated, service_role;
revoke all on function private.set_project_status(uuid, uuid, public.project_status) from public, anon, authenticated, service_role;
revoke all on function private.create_product(uuid, uuid, text, text, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.update_product(uuid, uuid, text, text, text, text, jsonb) from public, anon, authenticated, service_role;
-- Les validations ne sont appelées que par les fonctions ci-dessous (SECURITY DEFINER) : aucun autre droit.
grant execute on function private.create_project(uuid, public.project_type, text, jsonb, uuid) to authenticated;
grant execute on function private.update_project(uuid, uuid, text, jsonb, uuid) to authenticated;
grant execute on function private.set_project_status(uuid, uuid, public.project_status) to authenticated;
grant execute on function private.create_product(uuid, uuid, text, text, text, text, jsonb) to authenticated;
grant execute on function private.update_product(uuid, uuid, text, text, text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Enveloppes publiques (SECURITY INVOKER) : surface PostgREST
-- ---------------------------------------------------------------------------
create function public.create_project(
  p_org uuid, p_type public.project_type, p_name text, p_settings jsonb, p_owner uuid default null
)
returns uuid language sql security invoker set search_path = ''
as $$ select private.create_project(p_org, p_type, p_name, p_settings, p_owner); $$;

create function public.update_project(p_org uuid, p_id uuid, p_name text, p_settings jsonb, p_owner uuid)
returns void language sql security invoker set search_path = ''
as $$ select private.update_project(p_org, p_id, p_name, p_settings, p_owner); $$;

create function public.set_project_status(p_org uuid, p_id uuid, p_status public.project_status)
returns void language sql security invoker set search_path = ''
as $$ select private.set_project_status(p_org, p_id, p_status); $$;

create function public.create_product(
  p_org uuid, p_project uuid, p_kind text, p_offer text, p_price_hint text, p_landing_url text, p_assets jsonb
)
returns uuid language sql security invoker set search_path = ''
as $$ select private.create_product(p_org, p_project, p_kind, p_offer, p_price_hint, p_landing_url, p_assets); $$;

create function public.update_product(
  p_org uuid, p_id uuid, p_kind text, p_offer text, p_price_hint text, p_landing_url text, p_assets jsonb
)
returns void language sql security invoker set search_path = ''
as $$ select private.update_product(p_org, p_id, p_kind, p_offer, p_price_hint, p_landing_url, p_assets); $$;

revoke all on function public.create_project(uuid, public.project_type, text, jsonb, uuid) from public, anon, service_role;
revoke all on function public.update_project(uuid, uuid, text, jsonb, uuid) from public, anon, service_role;
revoke all on function public.set_project_status(uuid, uuid, public.project_status) from public, anon, service_role;
revoke all on function public.create_product(uuid, uuid, text, text, text, text, jsonb) from public, anon, service_role;
revoke all on function public.update_product(uuid, uuid, text, text, text, text, jsonb) from public, anon, service_role;
grant execute on function public.create_project(uuid, public.project_type, text, jsonb, uuid) to authenticated;
grant execute on function public.update_project(uuid, uuid, text, jsonb, uuid) to authenticated;
grant execute on function public.set_project_status(uuid, uuid, public.project_status) to authenticated;
grant execute on function public.create_product(uuid, uuid, text, text, text, text, jsonb) to authenticated;
grant execute on function public.update_product(uuid, uuid, text, text, text, text, jsonb) to authenticated;
