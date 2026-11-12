-- Retour arrière de 20261118100000_projects_products.sql
-- ATTENTION : supprime TOUS les projets et produits. Les compteurs d'usage « projects » repassent à 0.

drop function if exists public.update_product(uuid, uuid, text, text, text, text, jsonb);
drop function if exists public.create_product(uuid, uuid, text, text, text, text, jsonb);
drop function if exists public.set_project_status(uuid, uuid, public.project_status);
drop function if exists public.update_project(uuid, uuid, text, jsonb, uuid);
drop function if exists public.create_project(uuid, public.project_type, text, jsonb, uuid);
drop function if exists private.update_product(uuid, uuid, text, text, text, text, jsonb);
drop function if exists private.create_product(uuid, uuid, text, text, text, text, jsonb);
drop function if exists private.set_project_status(uuid, uuid, public.project_status);
drop function if exists private.update_project(uuid, uuid, text, jsonb, uuid);
drop function if exists private.create_project(uuid, public.project_type, text, jsonb, uuid);
drop function if exists private.assert_project_manager(uuid);

-- Quota « projects » : retour à la définition du J14 (usage 0 tant que le module n'existe pas).
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
  return 0;
end;
$$;

drop trigger if exists release_project_ownership on public.organization_members;
drop function if exists private.release_project_ownership();
drop trigger if exists audit_products on public.products;
drop trigger if exists audit_projects on public.projects;
drop function if exists private.audit_products();
drop function if exists private.audit_projects();

drop table if exists public.products;
drop table if exists public.projects;

drop function if exists private.products_immutable();
drop function if exists private.projects_immutable();
drop function if exists private.is_valid_product_assets(uuid, uuid, jsonb);
drop function if exists private.is_valid_project_settings(public.project_type, jsonb);
drop function if exists private.jsonb_depth(jsonb);
drop function if exists private.is_safe_https_url(text);
drop function if exists private.is_safe_text(text, integer, integer, boolean);

drop type if exists public.project_status;
drop type if exists public.project_type;
