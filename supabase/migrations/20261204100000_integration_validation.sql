-- J34 — Validation d'une intégration (connexion WhatsApp, spec §9.3 ; plan J34).
--
-- La couche web appelle le fournisseur (WhatsApp : l'API Graph) avec le jeton déchiffré EN MÉMOIRE puis écrit le résultat ici. La fonction n'est
-- exécutable que par service_role : un utilisateur ne peut jamais déclarer une intégration « active » sans que le serveur ait vérifié le jeton. L'entreprise
-- vient du contexte vérifié par la route (jamais du corps de la requête) ; seuls les états `pending`, `active` et `error` changent (une intégration
-- déconnectée ou désactivée ne se réactive pas par une validation).
--  * `p_ok = true`  : statut `active`, `last_error` effacé, canaux inchangés (le propriétaire les relance) ;
--  * `p_ok = false` : statut `error`, `last_error` = code court (jamais un texte du fournisseur : il peut citer le numéro ou le jeton) ;
--  * audit : `integration.validated` / `integration.validation_failed`, fournisseur, code et identifiant de l'ACTEUR (l'utilisateur qui a demandé la vérification, fourni par
--    le serveur : sous service_role, `auth.uid()` est vide) ;
--  * WhatsApp : une validation réussie exige le secret de l'app (`webhook_secret_ref`), sinon aucun événement reçu ne passerait la signature.
-- codes d'erreur de validation ajoutés à ceux de la synchronisation (J25) : jeton refusé, compte introuvable, fournisseur indisponible
alter table public.integrations drop constraint integrations_error_valid;
alter table public.integrations add constraint integrations_error_valid check (
  last_error is null or last_error in ('file_missing', 'file_malformed', 'mapping_invalid', 'failed', 'provider_auth', 'provider_account', 'provider_unavailable', 'provider_unreadable')
);

create function private.integration_set_validation(p_org uuid, p_integration uuid, p_ok boolean, p_code text, p_actor uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.integrations;
  v_status text;
begin
  if p_org is null or p_integration is null or p_ok is null or p_actor is null
     or (p_ok and p_code is not null)
     or (not p_ok and (p_code is null or p_code not in ('provider_auth', 'provider_account', 'provider_unavailable', 'provider_unreadable'))) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select * into v_row from public.integrations i where i.organization_id = p_org and i.id = p_integration for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if v_row.status not in ('pending', 'active', 'error') or v_row.secret_ref is null then
    raise exception 'integration_not_validatable' using errcode = 'P0001';
  end if;
  -- WhatsApp : sans le secret de l'app, tous les événements reçus seraient refusés : on n'affiche pas « vérifié » pour une intégration qui ne recevra rien
  if p_ok and v_row.provider = 'whatsapp' and v_row.webhook_secret_ref is null then
    raise exception 'integration_not_validatable' using errcode = 'P0001';
  end if;
  v_status := case when p_ok then 'active' else 'error' end;
  update public.integrations set status = v_status, last_error = case when p_ok then null else p_code end
   where organization_id = p_org and id = p_integration;
  perform private.audit_write(p_org, case when p_ok then 'integration.validated' else 'integration.validation_failed' end, 'integration', p_integration, null,
    case when p_ok then pg_catalog.jsonb_build_object('provider', v_row.provider, 'actor', p_actor)
         else pg_catalog.jsonb_build_object('provider', v_row.provider, 'code', p_code, 'actor', p_actor) end);
  return v_status;
end;
$$;
revoke all on function private.integration_set_validation(uuid, uuid, boolean, text, uuid) from public, anon, authenticated, service_role;
grant execute on function private.integration_set_validation(uuid, uuid, boolean, text, uuid) to service_role;

create function public.integration_set_validation(p_org uuid, p_integration uuid, p_ok boolean, p_code text, p_actor uuid)
returns text language sql security invoker set search_path = ''
as $$ select private.integration_set_validation(p_org, p_integration, p_ok, p_code, p_actor); $$;
revoke all on function public.integration_set_validation(uuid, uuid, boolean, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.integration_set_validation(uuid, uuid, boolean, text, uuid) to service_role;
