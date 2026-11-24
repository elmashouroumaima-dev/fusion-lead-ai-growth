-- S-02 (revue de sécurité de la Phase 3, 2026-11-24) : plus de réservation d'un compte fournisseur entre entreprises.
-- Avant : l'index unique `integrations_provider_account_global` sur (provider, external_account_id) était global, sans filtre d'état, et rien ne prouvait que
-- l'entreprise possédait le numéro ou le domaine : une entreprise pouvait bloquer la connexion d'une autre, ses webhooks se résolvaient vers la mauvaise ligne,
-- et la réponse 409 révélait qu'un compte était pris. Désormais :
--  * l'unicité est PAR ENTREPRISE seulement (`integrations_org_account_key`, qui existe déjà) : deux entreprises peuvent déclarer le même compte ;
--  * un webhook retrouve ses candidats (`webhook_resolve_candidates`, jusqu'à 5, actifs d'abord) et c'est la SIGNATURE (secret de webhook de chaque candidat)
--    qui désigne l'entreprise : un événement authentique du fournisseur n'est signé que pour son vrai propriétaire, un attaquant ne reçoit que ses propres
--    événements. Même logique pour le Basic Auth de Postmark (mot de passe propre à chaque intégration).
--  * `webhook_resolve_integration` (un seul résultat) est remplacée par `webhook_resolve_candidates` (liste).
-- Retour arrière : supabase/rollbacks/20261220100000_integration_account_per_org.sql

drop index public.integrations_provider_account_global;

drop function public.webhook_resolve_integration(text, text, text);
drop function private.webhook_resolve_integration(text, text, text);

create function private.webhook_resolve_candidates(p_provider text, p_account text, p_gateway text default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('organization_id', c.organization_id, 'integration_id', c.id) order by c.rank, c.created_at), '[]'::jsonb)
    from (
      select i.organization_id, i.id, i.created_at,
             case i.status when 'active' then 0 when 'error' then 1 else 2 end as rank
        from public.integrations i
       where i.provider = p_provider
         and i.external_account_id = p_account
         and i.provider in ('email', 'whatsapp')
         and (p_gateway is null or i.gateway = p_gateway)
         and i.status in ('pending', 'active', 'error')
       order by 4, i.created_at
       limit 5
    ) c;
$$;
create function public.webhook_resolve_candidates(p_provider text, p_account text, p_gateway text default null)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.webhook_resolve_candidates(p_provider, p_account, p_gateway); $$;
revoke all on function private.webhook_resolve_candidates(text, text, text) from public, anon, authenticated, service_role;
grant execute on function private.webhook_resolve_candidates(text, text, text) to service_role;
revoke all on function public.webhook_resolve_candidates(text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.webhook_resolve_candidates(text, text, text) to service_role;
