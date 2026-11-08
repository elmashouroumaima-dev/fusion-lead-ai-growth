-- J17 (partie 2) — Fichiers des produits : bucket privé `assets` et politiques Storage (ADR 005 §12, ADR 007 G-D11, spec §11).
-- Retour arrière : supabase/rollbacks/20261119100000_storage_assets.sql
--
-- Décisions (mini-plan validé le 2026-11-08) :
--  * bucket PRIVÉ `assets` (aucun accès public), 10 Mo au plus par fichier, types autorisés : png, jpeg, webp, pdf (le CSV
--    viendra avec l'import des leads, J23). La limite et les types sont aussi imposés par Storage ; les octets (types réels)
--    sont vérifiés par l'application avant l'envoi ;
--  * chemin OBLIGATOIRE `{organization_id}/{project_id}/{asset_id}/{fichier}` (UUID en minuscules, nom `[A-Za-z0-9._-]`, 120
--    caractères au plus) : le projet doit exister DANS cette entreprise (un utilisateur ne peut pas ranger un fichier sous le
--    projet d'une autre entreprise) ;
--  * lecture : membres actifs de l'entreprise du chemin (tous les rôles) ; écriture et suppression : owner et admin, projet
--    ACTIF seulement ; aucune mise à jour (pas d'écrasement : les noms sont uniques) ; `anon` : rien ;
--  * liens de lecture : URL signées courtes générées par le serveur (jamais d'URL publique).

-- ---------------------------------------------------------------------------
-- Bucket
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('assets', 'assets', false, 10485760, array['image/png', 'image/jpeg', 'image/webp', 'application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Fonctions des politiques (SECURITY DEFINER, search_path vide) : analysent le chemin puis relisent l'appartenance
-- ---------------------------------------------------------------------------
create function private.asset_path_ok(p_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_name is not null
     and p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9._-]{1,120}$';
$$;

-- Lecture : le chemin est valide, le projet existe dans l'entreprise du chemin et l'appelant en est membre actif.
create function private.can_read_asset(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_project uuid;
begin
  if not private.asset_path_ok(p_name) then
    return false;
  end if;
  v_org := pg_catalog.split_part(p_name, '/', 1)::uuid;
  v_project := pg_catalog.split_part(p_name, '/', 2)::uuid;
  return private.is_member(v_org)
     and exists (select 1 from public.projects p where p.id = v_project and p.organization_id = v_org);
end;
$$;

-- Écriture et suppression : owner ou admin actif de l'entreprise du chemin, projet actif de cette entreprise.
create function private.can_write_asset(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_project uuid;
begin
  if not private.asset_path_ok(p_name) then
    return false;
  end if;
  v_org := pg_catalog.split_part(p_name, '/', 1)::uuid;
  v_project := pg_catalog.split_part(p_name, '/', 2)::uuid;
  return private.has_role(v_org, array['company_owner', 'company_admin']::public.app_role[])
     and exists (
       select 1 from public.projects p
        where p.id = v_project and p.organization_id = v_org and p.status = 'active'
     );
end;
$$;

revoke all on function private.asset_path_ok(text) from public, anon, authenticated, service_role;
revoke all on function private.can_read_asset(text) from public, anon, authenticated, service_role;
revoke all on function private.can_write_asset(text) from public, anon, authenticated, service_role;
-- Les politiques s'exécutent avec les droits de l'appelant : seul `authenticated` en a besoin.
grant execute on function private.asset_path_ok(text) to authenticated;
grant execute on function private.can_read_asset(text) to authenticated;
grant execute on function private.can_write_asset(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Politiques sur storage.objects (RLS déjà activée par Storage) : pas de mise à jour, rien pour anon
-- ---------------------------------------------------------------------------
create policy assets_select on storage.objects
  for select to authenticated
  using (bucket_id = 'assets' and private.can_read_asset(name));

create policy assets_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'assets' and private.can_write_asset(name));

create policy assets_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'assets' and private.can_write_asset(name));

-- ---------------------------------------------------------------------------
-- Fichiers d'un produit : ajout et retrait ATOMIQUES (revue sécurité J17 : pertes de mises à jour sous concurrence, rattachement
-- d'un fichier à un autre produit). Les fichiers ne se modifient plus que par ces fonctions : `update_product` n'écrit plus la
-- colonne `assets` (son paramètre p_assets est conservé pour la compatibilité de signature et IGNORÉ).
-- ---------------------------------------------------------------------------
-- Associe un chemin au produit, sous verrou de la ligne du produit : l'objet doit exister, ne pas être déjà associé à un AUTRE
-- produit, le projet doit être actif ; 50 fichiers au plus ; chemin déjà associé : sans effet.
create function private.append_product_asset(p_org uuid, p_product uuid, p_path text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_assets jsonb;
  v_status public.project_status;
begin
  perform private.assert_project_manager(p_org);
  if p_product is null or p_path is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;

  select pr.project_id, pr.assets into v_project, v_assets from public.products pr
   where pr.id = p_product and pr.organization_id = p_org for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  select p.status into v_status from public.projects p where p.id = v_project and p.organization_id = p_org;
  if v_status = 'archived' then
    raise exception 'project_archived' using errcode = 'P0001';
  end if;
  if not private.is_valid_product_assets(p_org, v_project, pg_catalog.jsonb_build_array(p_path))
     or not exists (select 1 from storage.objects o where o.bucket_id = 'assets' and o.name = p_path)
     or exists (select 1 from public.products x where x.organization_id = p_org and x.id <> p_product and x.assets ? p_path) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  if v_assets ? p_path then
    return;
  end if;
  if pg_catalog.jsonb_array_length(v_assets) >= 50 then
    raise exception 'too_many_files' using errcode = 'P0001';
  end if;
  update public.products set assets = assets || pg_catalog.jsonb_build_array(p_path)
   where id = p_product and organization_id = p_org;
end;
$$;

-- Retire un chemin du produit (sous verrou) ; renvoie le nombre de produits qui référencent ENCORE ce chemin (0 : l'objet peut
-- être supprimé). Chemin non associé : not_found ; projet archivé : project_archived.
create function private.remove_product_asset(p_org uuid, p_product uuid, p_path text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_assets jsonb;
  v_status public.project_status;
begin
  perform private.assert_project_manager(p_org);
  if p_product is null or p_path is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;

  select pr.project_id, pr.assets into v_project, v_assets from public.products pr
   where pr.id = p_product and pr.organization_id = p_org for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  select p.status into v_status from public.projects p where p.id = v_project and p.organization_id = p_org;
  if v_status = 'archived' then
    raise exception 'project_archived' using errcode = 'P0001';
  end if;
  if not (v_assets ? p_path) then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  update public.products set assets = assets - p_path where id = p_product and organization_id = p_org;
  return (select count(*)::integer from public.products x where x.organization_id = p_org and x.assets ? p_path);
end;
$$;

-- update_product : plus de modification des fichiers (la liste vient d'un client, non fiable ; sous concurrence elle écrasait les
-- ajouts). Corps du J16 sans la colonne `assets`.
create or replace function private.update_product(
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
  select p.status into v_status from public.projects p where p.id = v_project and p.organization_id = p_org;
  if v_status = 'archived' then
    raise exception 'project_archived' using errcode = 'P0001';
  end if;

  update public.products
     set kind = p_kind, offer = p_offer, price_hint = p_price_hint, landing_url = p_landing_url
   where id = p_id and organization_id = p_org;
end;
$$;

revoke all on function private.append_product_asset(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.remove_product_asset(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function private.append_product_asset(uuid, uuid, text) to authenticated;
grant execute on function private.remove_product_asset(uuid, uuid, text) to authenticated;

create function public.append_product_asset(p_org uuid, p_product uuid, p_path text)
returns void language sql security invoker set search_path = ''
as $$ select private.append_product_asset(p_org, p_product, p_path); $$;

create function public.remove_product_asset(p_org uuid, p_product uuid, p_path text)
returns integer language sql security invoker set search_path = ''
as $$ select private.remove_product_asset(p_org, p_product, p_path); $$;

revoke all on function public.append_product_asset(uuid, uuid, text) from public, anon, service_role;
revoke all on function public.remove_product_asset(uuid, uuid, text) from public, anon, service_role;
grant execute on function public.append_product_asset(uuid, uuid, text) to authenticated;
grant execute on function public.remove_product_asset(uuid, uuid, text) to authenticated;
