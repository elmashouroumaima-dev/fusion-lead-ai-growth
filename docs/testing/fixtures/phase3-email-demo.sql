-- Données pour la démonstration des webhooks e-mail (J32) : voir docs/testing/phase2-3-functional-tests.md, partie « Webhooks e-mail ».
-- PRÉREQUIS : docs/testing/fixtures/phase2-demo-data.sql chargé, ET l'intégration e-mail « demo-mail-guide » créée par
--   pnpm test:call shared POST /api/integrations '{"provider":"email","external_account_id":"demo-mail-guide","scopes":["send","receive"],"secret":"jeton-de-test-0123456789-abcdef"}'
-- Ce script rend l'intégration et son canal « ventes@demo.test » ACTIFS (aucun écran ne le permet encore : le flux d'activation arrive avec
-- le compte d'essai du fournisseur) et prépare, pour 3 contacts de démonstration, un e-mail déjà « accepté » par le fournisseur
-- (identifiants pm-guide-nadia, pm-guide-karim, pm-guide-youssef), comme après un envoi réel. AUCUN e-mail n'est envoyé.
--
--   docker exec -i supabase_db_fusion-leap psql -U postgres -v ON_ERROR_STOP=1 < docs/testing/fixtures/phase3-email-demo.sql

begin;

do $demo$
declare
  org constant uuid := 'a0000000-0000-4000-8000-0000000000a1';
  owner constant uuid := '00000000-0000-4000-8000-000000000001';
  integration uuid;
  channel uuid;
  contact uuid;
  conv uuid;
  recorded jsonb;
  slug text;
begin
  select i.id into integration from public.integrations i where i.organization_id = org and i.external_account_id = 'demo-mail-guide';
  if integration is null then
    raise exception 'créer d''abord l''intégration « demo-mail-guide » (voir l''en-tête de ce fichier)';
  end if;
  update public.integrations set status = 'active' where organization_id = org and id = integration;
  insert into public.channels (organization_id, type, integration_id, sender_identity, status)
    values (org, 'email', integration, 'ventes@demo.test', 'active')
    on conflict (organization_id, type, sender_identity) do update set status = 'active', send_paused = false;
  select ch.id into channel from public.channels ch where ch.organization_id = org and ch.integration_id = integration and ch.sender_identity = 'ventes@demo.test';

  foreach slug in array array['nadia', 'karim', 'youssef'] loop
    select ct.id into contact from public.contacts ct where ct.organization_id = org and ct.email_normalized = slug || '@demo.test';
    conv := (private.conversation_get_or_create(org, contact, channel) ->> 'id')::uuid;
    recorded := private.message_record(org, conv, 'outbound', null, 'Bonjour, voici notre offre (démonstration).', 'guide-' || slug || '-0001', null);
    -- l'approbation humaine et l'acceptation par le fournisseur sont posées directement (le flux d'envoi réel est testé par les suites automatiques)
    update public.messages
       set approved_by = owner, approved_at = now(), approved_purpose = 'marketing', approved_recipient = slug || '@demo.test',
           status = 'accepted', provider_message_id = 'pm-guide-' || slug, send_claimed_at = now(), sent_at = now()
     where organization_id = org and id = (recorded ->> 'message_id')::uuid;
  end loop;
end
$demo$;

commit;

select c.email_normalized as contact, m.status, m.provider_message_id
  from public.messages m
  join public.conversations v on v.organization_id = m.organization_id and v.id = m.conversation_id
  join public.contacts c on c.organization_id = v.organization_id and c.id = v.contact_id
 where m.provider_message_id like 'pm-guide-%' order by 1;
