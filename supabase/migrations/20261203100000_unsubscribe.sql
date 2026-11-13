-- J33 — Désabonnement (spec §9.2, plan J33, ADR 008).
--
-- Un destinataire clique le lien signé d'un e-mail (ou l'en-tête `List-Unsubscribe` One-Click) : la couche web vérifie la signature du jeton
-- (HMAC, aucune donnée personnelle dedans : seulement l'entreprise et le message) puis appelle `unsubscribe_apply` avec la clé service_role.
-- L'entreprise et le contact viennent TOUJOURS de la ligne du message, jamais du client.
--
--  * `unsubscribe_apply(p_org, p_message)` (service_role seulement, une transaction, idempotente) :
--      1. révoque TOUS les consentements e-mail actifs du contact (historique append-only : seule la date de révocation s'ajoute) ;
--      2. inscrit l'adresse dans `suppressions` (raison `unsubscribe`), ce qui bloque aussi tout nouveau consentement saisi par erreur ;
--      3. annule les messages sortants en file, non encore réclamés, du contact (statut `cancelled`) et les jobs `send_message` correspondants ;
--      4. audite (identifiants et nombres seulement : jamais l'adresse ni le corps).
--    Un envoi déjà réclamé par le worker n'est pas touché ici : le contrôle final de `checkCanSend` (consentement et suppression relus dans la
--    transaction de la réclamation) le refuse si le désabonnement a eu lieu avant la réclamation ; après la réclamation, l'appel au fournisseur peut
--    partir (fenêtre de quelques secondes, documentée).
--  * Rien n'est exposé à `authenticated` : la page publique n'a pas de session.
--  * Lever une désinscription (réabonnement) n'existe pas encore : une personne habilitée devra le faire par une action auditée (écran contacts, J30b).

create function private.unsubscribe_apply(p_org uuid, p_message uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m public.messages;
  v_contact public.contacts;
  v_address text;
  v_supp uuid;
  v_revoked integer;
  v_cancelled integer;
  v_new boolean := false;
begin
  if p_org is null or p_message is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select * into v_m from public.messages m where m.organization_id = p_org and m.id = p_message and m.direction = 'outbound';
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  select ct.* into v_contact
    from public.conversations c
    join public.contacts ct on ct.organization_id = c.organization_id and ct.id = c.contact_id
   where c.organization_id = p_org and c.id = v_m.conversation_id
   for update of ct;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  -- l'adresse retirée est celle où le message est parti (figée à l'approbation), à défaut celle du contact
  v_address := coalesce(v_m.approved_recipient, v_contact.email_normalized);

  update public.consent_events e set revoked_at = pg_catalog.now()
   where e.organization_id = p_org and e.contact_id = v_contact.id and e.channel = 'email' and e.revoked_at is null;
  get diagnostics v_revoked = row_count;
  if v_revoked > 0 then
    perform private.refresh_consent_status(p_org, v_contact.id);
  end if;

  if v_address is not null then
    insert into public.suppressions (organization_id, channel, value_normalized, reason, source_message_id)
    values (p_org, 'email', v_address, 'unsubscribe', v_m.id)
    on conflict (organization_id, channel, value_normalized) do nothing
    returning id into v_supp;
    if v_supp is not null then
      v_new := true;
      perform private.audit_write(p_org, 'suppression.added', 'suppression', v_supp, null, pg_catalog.jsonb_build_object('reason', 'unsubscribe'));
    end if;
  end if;

  -- messages sortants en file du même contact, pas encore réclamés : annulés avec leur job d'envoi
  with doomed as (
    select m.id
      from public.messages m
      join public.conversations c on c.organization_id = m.organization_id and c.id = m.conversation_id
     where m.organization_id = p_org and c.contact_id = v_contact.id and m.direction = 'outbound'
       and m.status = 'queued' and m.send_claimed_at is null
       and exists (select 1 from public.channels ch where ch.organization_id = m.organization_id and ch.id = m.channel_id and ch.type = 'email')
     for update of m
  ), upd as (
    update public.messages m set status = 'cancelled'
      from doomed d where m.organization_id = p_org and m.id = d.id
    returning m.id
  ), jobs_cancelled as (
    update public.jobs j set status = 'cancelled', finished_at = pg_catalog.now()
     where j.organization_id = p_org and j.kind = 'send_message' and j.status = 'queued'
       and (j.payload ->> 'message_id') in (select u.id::text from upd u)
    returning j.id
  )
  select pg_catalog.count(*)::integer into v_cancelled from upd;
  if v_cancelled > 0 then
    perform private.audit_write(p_org, 'message.cancelled', 'contact', v_contact.id, null, pg_catalog.jsonb_build_object('reason', 'unsubscribe', 'count', v_cancelled));
  end if;

  if v_revoked > 0 or v_new or v_cancelled > 0 then
    perform private.audit_write(p_org, 'unsubscribe.applied', 'contact', v_contact.id, null,
      pg_catalog.jsonb_build_object('source_message_id', v_m.id, 'revoked', v_revoked, 'cancelled', v_cancelled));
    return pg_catalog.jsonb_build_object('outcome', 'applied', 'revoked', v_revoked, 'cancelled', v_cancelled);
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'already', 'revoked', 0, 'cancelled', 0);
end;
$$;

revoke all on function private.unsubscribe_apply(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function private.unsubscribe_apply(uuid, uuid) to service_role;

create function public.unsubscribe_apply(p_org uuid, p_message uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.unsubscribe_apply(p_org, p_message); $$;
revoke all on function public.unsubscribe_apply(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.unsubscribe_apply(uuid, uuid) to service_role;
