-- Données pour les tests de la boîte de réception et des réponses (J37, J38) : voir docs/testing/phase4-inbox-replies-functional-tests.md.
-- PRÉREQUIS : base remise à zéro (pnpm db:reset). Un second chargement est refusé (intégration déjà présente).
-- Crée, pour Alpha : une intégration e-mail et un canal ACTIFS (ventes@demo.test), 4 contacts (domaine .test) et 4 conversations, chacune avec
-- un message ENTRANT du contact (ce qui ouvre le consentement conversationnel de 30 jours). AUCUN e-mail n'est envoyé.
--
--   docker exec -i supabase_db_fusion-leap psql -U postgres -v ON_ERROR_STOP=1 < docs/testing/fixtures/phase4-inbox-demo.sql
--
--   Nadia : assignée au commercial (alpha-sales), ouverte      Karim : non assignée (à trier)
--   Salma : assignée à l'administrateur (alpha-admin), ouverte  Omar  : assigné au commercial, « ne pas contacter »

begin;

do $demo$
declare
  org constant uuid := 'a0000000-0000-4000-8000-0000000000a1';
  sales constant uuid := '00000000-0000-4000-8000-000000000004';
  admin constant uuid := '00000000-0000-4000-8000-000000000002';
  integ uuid;
  chan uuid;
  contact uuid;
  conv uuid;
  r record;
begin
  if exists (select 1 from public.integrations where organization_id = org and external_account_id = 'demo-inbox-guide') then
    raise exception 'données déjà chargées : refaire pnpm db:reset pour repartir de zéro';
  end if;

  insert into public.integrations (organization_id, provider, status, external_account_id) values (org, 'email', 'active', 'demo-inbox-guide') returning id into integ;
  insert into public.channels (organization_id, type, integration_id, sender_identity, status) values (org, 'email', integ, 'ventes@demo.test', 'active') returning id into chan;

  for r in
    select * from (values
      ('Demo Nadia', 'nadia', sales, 'open', false, 1),
      ('Demo Karim', 'karim', null::uuid, 'to_triage', false, 2),
      ('Demo Salma', 'salma', admin, 'open', false, 3),
      ('Demo Omar', 'omar', sales, 'open', true, 4)
    ) as t (name, slug, assignee, state, dnc, hours)
  loop
    insert into public.contacts (organization_id, name, email_raw, email_normalized, do_not_contact)
      values (org, r.name, r.slug || '@demo.test', r.slug || '@demo.test', r.dnc) returning id into contact;
    conv := (private.conversation_get_or_create(org, contact, chan) ->> 'id')::uuid;
    perform private.message_record(org, conv, 'inbound', 'demo-inbox.' || r.slug, 'Bonjour, une question.', null, now() - make_interval(hours => r.hours));
    if r.assignee is not null then
      update public.conversations set assignee_id = r.assignee, state = r.state where id = conv;
    end if;
  end loop;
end
$demo$;

commit;

select k.name, c.state, c.assignee_id is not null as assignee from public.conversations c join public.contacts k on k.id = c.contact_id order by k.name;
