-- Démonstration de la chaîne de contrôles d'envoi (J31) SANS envoyer aucun e-mail : pour 3 contacts de démonstration, on prépare un message
-- sortant (« queued ») puis le propriétaire l'APPROUVE (ce qui met le job d'envoi en file). Le worker relit tout l'état et REFUSE chaque envoi
-- avant d'appeler le fournisseur : aucun appel réseau n'a lieu.
-- PRÉREQUIS : phase2-demo-data.sql et phase3-email-demo.sql chargés ET le webhook-demo exécuté (rebond de karim, plainte de youssef) ; worker lancé.
-- Résultats attendus (après quelques secondes) : nadia = refused_no_consent, karim = refused_suppressed, youssef = refused_do_not_contact.
--   docker exec -i supabase_db_fusion-leap psql -U postgres -v ON_ERROR_STOP=1 < docs/testing/fixtures/phase3-send-refusals.sql

begin;

do $prep$
declare
  org constant uuid := 'a0000000-0000-4000-8000-0000000000a1';
  channel uuid;
  contact uuid;
  conv uuid;
  slug text;
begin
  select ch.id into channel from public.channels ch where ch.organization_id = org and ch.sender_identity = 'ventes@demo.test';
  foreach slug in array array['nadia', 'karim', 'youssef'] loop
    select ct.id into contact from public.contacts ct where ct.organization_id = org and ct.email_normalized = slug || '@demo.test';
    conv := (private.conversation_get_or_create(org, contact, channel) ->> 'id')::uuid;
    perform private.message_record(org, conv, 'outbound', null, 'Deuxieme message de demonstration pour ' || slug, 'guide-refus-' || slug, null);
  end loop;
end
$prep$;

-- approbation humaine : au nom du propriétaire d'Alpha (fonction de l'application, qui met aussi le job d'envoi en file)
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000001', 'role', 'authenticated')::text, true);
set local role authenticated;
select public.message_approve('a0000000-0000-4000-8000-0000000000a1', m.id, 'marketing')
  from public.messages m where m.idempotency_key like 'guide-refus-%';

commit;
