-- Checkpoint C3 (J41) : fait approuver PAR LE PROPRIÉTAIRE un message sortant vers le contact de test, ce qui met le job d'envoi en file (le worker
-- l'envoie au fournisseur RÉEL). Sert pour WhatsApp (la boîte de réception ne répond encore que par e-mail, écart n°3 de docs/checkpoints/C3.md)
-- et pour répéter un envoi e-mail sans passer par l'écran. Même chaîne que l'application : approbation humaine (owner), puis contrôle final du worker.
--
--   docker exec -i supabase_db_fusion-leap psql -U postgres -v ON_ERROR_STOP=1 \
--     -v channel='whatsapp' -v tester_email='<votre adresse de test>' -v body='Bonjour, test C3 WhatsApp.' \
--     < docs/testing/fixtures/c3-approve.sql
--
-- `channel` = `email` ou `whatsapp`. Finalité « service » (consentement enregistré par c3-setup.sql). La finalité « reply » est réservée au
-- composeur de la boîte de réception : message_approve la refuse. Hors fenêtre de 24 h, un message WhatsApp libre est REFUSÉ par le worker
-- (modèle approuvé obligatoire : voir le guide).
\set org 'a0000000-0000-4000-8000-0000000000a1'
\set owner '00000000-0000-4000-8000-000000000001'
begin;
select set_config('c3.org', :'org', true), set_config('c3.owner', :'owner', true), set_config('c3.channel', :'channel', true),
       set_config('c3.tester_email', :'tester_email', true), set_config('c3.body', :'body', true);

do $$
declare
  v_org constant uuid := current_setting('c3.org')::uuid;
  v_conv uuid;
  v_id uuid;
  v_key text := 'c3-' || gen_random_uuid()::text;
begin
  select c.id into v_conv
    from public.conversations c
    join public.contacts ct on ct.organization_id = c.organization_id and ct.id = c.contact_id
    join public.channels ch on ch.organization_id = c.organization_id and ch.id = c.channel_id
   where c.organization_id = v_org and ct.email_normalized = lower(current_setting('c3.tester_email')) and ch.type = current_setting('c3.channel')::public.channel_type
   limit 1;
  if v_conv is null then raise exception 'aucune conversation « % » pour % : exécuter c3-setup.sql d''abord', current_setting('c3.channel'), current_setting('c3.tester_email'); end if;
  v_id := (private.message_record(v_org, v_conv, 'outbound', null, current_setting('c3.body'), v_key, null) ->> 'message_id')::uuid;
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('c3.owner'), 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.message_approve(v_org, v_id, 'service');
  reset role;
  raise notice 'message % approuvé : le worker va l''envoyer', v_id;
end
$$;

commit;
