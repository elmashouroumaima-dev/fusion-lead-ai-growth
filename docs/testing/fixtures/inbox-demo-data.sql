-- Données de démonstration de la boîte de réception (J37) : un canal e-mail et un canal WhatsApp chez Alpha, quatre conversations
-- (deux par canal) sur les contacts de la démonstration des phases 2 et 3, quelques messages entrants et un sortant, une conversation
-- assignée au commercial d'Alpha. À charger APRÈS `phase2-demo-data.sql` (les contacts de la démonstration doivent exister) :
--   docker exec -i supabase_db_fusion-leap psql -U postgres -v ON_ERROR_STOP=1 < docs/testing/fixtures/inbox-demo-data.sql
-- Données de test uniquement (domaine .test). Aucun message n'est réellement envoyé : le message sortant reste « en file ».
-- Un second chargement est refusé (compte d'intégration déjà présent) : `pnpm db:reset` puis les deux fichiers de démonstration.

begin;

do $demo$
declare
  org constant uuid := 'a0000000-0000-4000-8000-0000000000a1';
  sales constant uuid := '00000000-0000-4000-8000-000000000004';
  mail_integration uuid;
  wa_integration uuid;
  mail_channel uuid;
  wa_channel uuid;
  c_nadia uuid;
  c_karim uuid;
  c_salma uuid;
  c_youssef uuid;
  v_conv uuid;
begin
  insert into public.integrations (organization_id, provider, status, external_account_id)
  values (org, 'email', 'active', 'demo-inbox-mail') returning id into mail_integration;
  insert into public.integrations (organization_id, provider, status, external_account_id)
  values (org, 'whatsapp', 'active', 'demo-inbox-wa') returning id into wa_integration;
  insert into public.channels (organization_id, type, integration_id, sender_identity, status)
  values (org, 'email', mail_integration, 'ventes@demo.test', 'active') returning id into mail_channel;
  insert into public.channels (organization_id, type, integration_id, sender_identity, status)
  values (org, 'whatsapp', wa_integration, '+212600000001', 'active') returning id into wa_channel;

  select id into c_nadia from public.contacts where organization_id = org and email_normalized = 'nadia@demo.test';
  select id into c_karim from public.contacts where organization_id = org and email_normalized = 'karim@demo.test';
  select id into c_salma from public.contacts where organization_id = org and email_normalized = 'salma@demo.test';
  select id into c_youssef from public.contacts where organization_id = org and email_normalized = 'youssef@demo.test';
  if c_nadia is null or c_karim is null or c_salma is null or c_youssef is null then
    raise exception 'chargez d''abord phase2-demo-data.sql';
  end if;

  -- Nadia (e-mail) : deux messages entrants, non assignée (à trier)
  v_conv := (private.conversation_get_or_create(org, c_nadia, mail_channel) ->> 'id')::uuid;
  perform private.message_record(org, v_conv, 'inbound', 'demo-mail-1', 'Bonjour, je souhaite un devis pour un site vitrine de 5 pages avec un formulaire de contact.', null, now() - interval '3 hours');
  perform private.message_record(org, v_conv, 'inbound', 'demo-mail-2', 'Pouvez-vous me dire sous quel délai il serait livré ? Merci.', null, now() - interval '2 hours');

  -- Karim (WhatsApp) : assignée au commercial, un message entrant puis une réponse en file
  v_conv := (private.conversation_get_or_create(org, c_karim, wa_channel) ->> 'id')::uuid;
  perform private.message_record(org, v_conv, 'inbound', 'demo-wa-1', 'Salam, vous faites aussi des boutiques en ligne ?', null, now() - interval '90 minutes');
  perform private.message_record(org, v_conv, 'outbound', null, 'Bonjour Karim, oui : parlons de votre projet.', 'demo-out-1-0000000001', null);
  update public.conversations set assignee_id = sales, state = 'open' where id = v_conv;

  -- Salma (e-mail) : un long message (l'aperçu de la liste est tronqué, le fil montre le texte complet)
  v_conv := (private.conversation_get_or_create(org, c_salma, mail_channel) ->> 'id')::uuid;
  perform private.message_record(org, v_conv, 'inbound', 'demo-mail-3', 'Bonjour,' || chr(10) || chr(10) || 'Nous sommes une petite entreprise de conseil et nous cherchons à refondre notre site. '
    || 'Nous aimerions un design sobre, un blog, une page de présentation de l''équipe, un espace presse et un formulaire de prise de rendez-vous. '
    || 'Nous avons déjà un nom de domaine et un hébergement, mais pas de maquettes. Quel serait le budget estimé et quelle serait la procédure ?' || chr(10) || chr(10) || 'Cordialement, Salma', null, now() - interval '1 hour');

  -- Youssef (WhatsApp) : un message court, non assignée
  v_conv := (private.conversation_get_or_create(org, c_youssef, wa_channel) ->> 'id')::uuid;
  perform private.message_record(org, v_conv, 'inbound', 'demo-wa-2', 'Merci pour le devis, je vous réponds demain.', null, now() - interval '20 minutes');
  -- Une seule transaction : tous les messages auraient le même `created_at`. On le date à l'heure de réception pour que l'ordre du fil et
  -- l'aperçu de la liste soient ceux d'un vrai flux (les messages réels arrivent dans des transactions séparées).
  update public.messages set created_at = received_at where organization_id = org and received_at is not null and provider_message_id like 'demo-%';
end
$demo$;

select 'conversations: ' || count(*) from public.conversations where organization_id = 'a0000000-0000-4000-8000-0000000000a1';
select 'messages: ' || count(*) from public.messages where organization_id = 'a0000000-0000-4000-8000-0000000000a1';

commit;
