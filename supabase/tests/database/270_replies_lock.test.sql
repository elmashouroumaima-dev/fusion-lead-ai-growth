-- J38 — Réponses et verrou : `conversation_reply` (message sortant + approbation de l'auteur + job d'envoi dans UNE transaction ; droits : owner et
-- admin partout, le commercial sur SES conversations, jamais marketing ni analyste ; idempotence ; e-mail seulement ; validation du texte), bail
-- humain (acquérir, un seul détenteur, expiration, libération à l'envoi), exclusion IA / humain (aucune réponse simultanée), reprise en main, et la
-- chaîne d'envoi adaptée (`message_send_claim` : approbateur commercial pour une réponse, consentement conversationnel de 30 jours, autres finalités
-- inchangées). Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(46);

-- U1 owner A · U2 admin A · U3 marketing A · U4 commercial A · U5 analyste A · U6 owner B · U7 second commercial A
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('ea200000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u' || n || '@rp.test', now()
    from generate_series(1, 7) n;
insert into public.organizations (id, name, slug) values
  ('eb200000-0000-4000-8000-00000000000a', 'RP Alpha', 'rp-alpha-test'),
  ('eb200000-0000-4000-8000-00000000000b', 'RP Beta', 'rp-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('eb200000-0000-4000-8000-00000000000a', 'ea200000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('eb200000-0000-4000-8000-00000000000a', 'ea200000-0000-4000-8000-000000000002', 'company_admin', 'active'),
  ('eb200000-0000-4000-8000-00000000000a', 'ea200000-0000-4000-8000-000000000003', 'marketing_manager', 'active'),
  ('eb200000-0000-4000-8000-00000000000a', 'ea200000-0000-4000-8000-000000000004', 'sales_agent', 'active'),
  ('eb200000-0000-4000-8000-00000000000a', 'ea200000-0000-4000-8000-000000000005', 'analyst', 'active'),
  ('eb200000-0000-4000-8000-00000000000b', 'ea200000-0000-4000-8000-000000000006', 'company_owner', 'active'),
  ('eb200000-0000-4000-8000-00000000000a', 'ea200000-0000-4000-8000-000000000007', 'sales_agent', 'active');
insert into public.subscriptions (organization_id, plan_id, status) values
  ('eb200000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'growth'), 'active'),
  ('eb200000-0000-4000-8000-00000000000b', (select id from public.plans where code = 'growth'), 'active');
insert into public.contacts (id, organization_id, name, email_raw, email_normalized, phone_e164) values
  ('ec200000-0000-4000-8000-0000000000a1', 'eb200000-0000-4000-8000-00000000000a', 'RP A1', 'a1@rp.test', 'a1@rp.test', null),
  ('ec200000-0000-4000-8000-0000000000a2', 'eb200000-0000-4000-8000-00000000000a', 'RP A2', 'a2@rp.test', 'a2@rp.test', null),
  ('ec200000-0000-4000-8000-0000000000a3', 'eb200000-0000-4000-8000-00000000000a', 'RP A3', 'a3@rp.test', 'a3@rp.test', null),
  ('ec200000-0000-4000-8000-0000000000a4', 'eb200000-0000-4000-8000-00000000000a', 'RP A4', null, null, '+212600000040'),
  ('ec200000-0000-4000-8000-0000000000a5', 'eb200000-0000-4000-8000-00000000000a', 'RP A5', 'a5@rp.test', 'a5@rp.test', null);

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $f$;
create function pg_temp.as_service() returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  set local role service_role;
end $f$;
create function pg_temp.as_anon() returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  set local role anon;
end $f$;
grant execute on function pg_temp.as_user(text), pg_temp.as_service(), pg_temp.as_anon() to public;

-- canaux d'Alpha : e-mail et WhatsApp (créés par l'owner avec les fonctions du J28)
select pg_temp.as_user('ea200000-0000-4000-8000-000000000001');
select public.create_provider_integration('eb200000-0000-4000-8000-00000000000a', 'email', 'rp-mail-a', '{}', 'ed200000-0000-4000-8000-000000000001', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1);
select public.create_provider_integration('eb200000-0000-4000-8000-00000000000a', 'whatsapp', 'rp-wa-a', '{}', 'ed200000-0000-4000-8000-000000000002', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1);
select public.create_channel('eb200000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'rp-mail-a'), 'email', 'ventes@rp.test', '{}');
select public.create_channel('eb200000-0000-4000-8000-00000000000a', (select id from public.integrations where external_account_id = 'rp-wa-a'), 'whatsapp', '+212600000030', '{}');
reset role;
update public.integrations set status = 'active' where external_account_id in ('rp-mail-a', 'rp-wa-a');
update public.channels set status = 'active' where sender_identity in ('ventes@rp.test', '+212600000030');

-- fils : A1, A2, A3, A5 par e-mail ; A4 par WhatsApp. Messages entrants récents (A1, A2, A5), ancien de 40 jours (A3).
select private.conversation_get_or_create('eb200000-0000-4000-8000-00000000000a', 'ec200000-0000-4000-8000-0000000000a1', (select id from public.channels where sender_identity = 'ventes@rp.test'));
select private.conversation_get_or_create('eb200000-0000-4000-8000-00000000000a', 'ec200000-0000-4000-8000-0000000000a2', (select id from public.channels where sender_identity = 'ventes@rp.test'));
select private.conversation_get_or_create('eb200000-0000-4000-8000-00000000000a', 'ec200000-0000-4000-8000-0000000000a3', (select id from public.channels where sender_identity = 'ventes@rp.test'));
select private.conversation_get_or_create('eb200000-0000-4000-8000-00000000000a', 'ec200000-0000-4000-8000-0000000000a4', (select id from public.channels where sender_identity = '+212600000030'));
select private.conversation_get_or_create('eb200000-0000-4000-8000-00000000000a', 'ec200000-0000-4000-8000-0000000000a5', (select id from public.channels where sender_identity = 'ventes@rp.test'));
select private.message_record('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a1'), 'inbound', 'rp.m1', 'Bonjour A1', null, now() - interval '1 hour');
select private.message_record('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a2'), 'inbound', 'rp.m2', 'Bonjour A2', null, now() - interval '1 hour');
select private.message_record('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a3'), 'inbound', 'rp.m3', 'Bonjour A3', null, now() - interval '40 days');
select private.message_record('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a4'), 'inbound', 'rp.m4', 'Bonjour A4', null, now() - interval '1 hour');
select private.message_record('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a5'), 'inbound', 'rp.m5', 'Bonjour A5', null, now() - interval '1 hour');
-- le commercial U4 a le fil A1 (assigné par l'owner), le commercial U7 le fil A5
select pg_temp.as_user('ea200000-0000-4000-8000-000000000001');
select public.assign_conversation('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a1'), 'ea200000-0000-4000-8000-000000000004');
select public.assign_conversation('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a5'), 'ea200000-0000-4000-8000-000000000007');
reset role;

-- ---------------------------------------------------------------------------
-- Droits d'exécution
-- ---------------------------------------------------------------------------
select ok(has_function_privilege('authenticated', 'public.conversation_reply(uuid,uuid,text,text)', 'execute')
      and has_function_privilege('authenticated', 'public.conversation_lock_acquire(uuid,uuid)', 'execute')
      and not has_function_privilege('service_role', 'public.conversation_reply(uuid,uuid,text,text)', 'execute')
      and not has_function_privilege('anon', 'public.conversation_reply(uuid,uuid,text,text)', 'execute'), 'répondre et prendre le bail : utilisateurs connectés seulement');
select ok(has_function_privilege('service_role', 'public.conversation_ai_claim(uuid,uuid)', 'execute')
      and not has_function_privilege('authenticated', 'public.conversation_ai_claim(uuid,uuid)', 'execute')
      and not has_function_privilege('anon', 'public.conversation_ai_claim(uuid,uuid)', 'execute'), 'prise du fil par l''IA : service_role seulement');

-- ---------------------------------------------------------------------------
-- Réponse du commercial responsable (U4, fil A1) : message queued + approbation + job
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea200000-0000-4000-8000-000000000004');
select is((select (public.conversation_reply('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a1'), 'Merci, voici le devis.', 'reply-key-0001') ->> 'duplicate')::boolean), false, 'le commercial répond sur son fil');
reset role;
select is((select status || ':' || direction || ':' || approved_purpose || ':' || approved_recipient from public.messages where idempotency_key = 'reply-key-0001'), 'queued:outbound:reply:a1@rp.test', 'message sortant en file, finalité « reply », adresse du contact figée');
select is((select approved_by::text from public.messages where idempotency_key = 'reply-key-0001'), 'ea200000-0000-4000-8000-000000000004', 'l''approbateur est l''auteur');
select is((select count(*)::int from public.jobs where kind = 'send_message' and payload ->> 'message_id' = (select id::text from public.messages where idempotency_key = 'reply-key-0001')), 1, 'un job d''envoi dans la même transaction');
select is((select count(*)::int from public.audit_logs where action = 'message.approved' and entity_id = (select id from public.messages where idempotency_key = 'reply-key-0001') and after::text not like '%devis%'), 1, 'audit « message.approved » sans le corps');

-- rejeu : même clé, même corps = même message, pas de second job ; même clé, autre corps = conflit
select pg_temp.as_user('ea200000-0000-4000-8000-000000000004');
select is((select (public.conversation_reply('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a1'), 'Merci, voici le devis.', 'reply-key-0001') ->> 'duplicate')::boolean), true, 'rejeu : même message');
select throws_ok($$select public.conversation_reply('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a1'), 'Un autre texte.', 'reply-key-0001')$$, 'P0001', 'idempotency_conflict', 'même clé, autre corps : conflit');
reset role;
select is((select count(*)::int from public.jobs where kind = 'send_message' and payload ->> 'message_id' = (select id::text from public.messages where idempotency_key = 'reply-key-0001')), 1, 'le rejeu ne crée pas de second job');

-- ---------------------------------------------------------------------------
-- Droits : commercial d'autrui, marketing, analyste, autre entreprise, owner / admin partout
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea200000-0000-4000-8000-000000000007');
select throws_ok($$select public.conversation_reply('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a1'), 'Intrus', 'reply-key-0002')$$, 'PT404', 'not_found', 'un commercial ne répond pas sur le fil d''un autre (introuvable)');
select pg_temp.as_user('ea200000-0000-4000-8000-000000000003');
select throws_ok($$select public.conversation_reply('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a1'), 'Marketing', 'reply-key-0003')$$, '42501', 'forbidden', 'marketing : interdit');
select pg_temp.as_user('ea200000-0000-4000-8000-000000000005');
select throws_ok($$select public.conversation_reply('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a1'), 'Analyste', 'reply-key-0004')$$, '42501', 'forbidden', 'analyste : interdit');
select pg_temp.as_user('ea200000-0000-4000-8000-000000000006');
select throws_ok($$select public.conversation_reply('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a1'), 'Beta', 'reply-key-0005')$$, '42501', 'forbidden', 'membre d''une autre entreprise : interdit');
select pg_temp.as_user('ea200000-0000-4000-8000-000000000001');
select is((select (public.conversation_reply('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a2'), 'Réponse de l''owner sur un fil non assigné.', 'reply-key-0006') ->> 'duplicate')::boolean), false, 'owner : répond sur n''importe quel fil de l''entreprise');
select pg_temp.as_user('ea200000-0000-4000-8000-000000000002');
select is((select (public.conversation_reply('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a5'), 'Réponse de l''admin.', 'reply-key-0007') ->> 'duplicate')::boolean), false, 'admin : répond sur le fil d''un commercial');
reset role;

-- ---------------------------------------------------------------------------
-- Validation et canal
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea200000-0000-4000-8000-000000000001');
select throws_ok($$select public.conversation_reply('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a2'), '', 'reply-key-0008')$$, '22023', 'validation_failed', 'corps vide refusé');
select throws_ok($$select public.conversation_reply('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a2'), repeat('x', 10001), 'reply-key-0009')$$, '22023', 'validation_failed', 'corps de plus de 10 000 caractères refusé');
select throws_ok($$select public.conversation_reply('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a2'), 'Texte' || chr(1) || 'piégé', 'reply-key-0010')$$, '22023', 'validation_failed', 'caractère de contrôle refusé');
select throws_ok($$select public.conversation_reply('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a2'), 'Texte', 'court')$$, '22023', 'validation_failed', 'clé d''idempotence mal formée refusée');
select throws_ok($$select public.conversation_reply('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a4'), 'Réponse WhatsApp', 'reply-key-0011')$$, 'P0001', 'channel_unsupported', 'WhatsApp : pas encore (le worker n''envoie que de l''e-mail)');
select is((select count(*)::int from public.messages where idempotency_key in ('reply-key-0008', 'reply-key-0009', 'reply-key-0010', 'reply-key-0011')), 0, 'aucun message n''est créé par un refus');
reset role;

-- ---------------------------------------------------------------------------
-- Bail humain : un seul détenteur, expiration, libération à l'envoi
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea200000-0000-4000-8000-000000000001');
select is((select public.conversation_lock_acquire('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a3')) ->> 'status'), 'acquired', 'l''owner prend le bail');
select pg_temp.as_user('ea200000-0000-4000-8000-000000000002');
select is((select public.conversation_lock_acquire('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a3')) ->> 'status'), 'held_by_other', 'un second membre ne peut pas prendre le bail (sans savoir qui le tient)');
select throws_ok($$select public.conversation_reply('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a3'), 'Je double', 'reply-key-0012')$$, 'P0001', 'conversation_locked', 'une réponse est refusée tant qu''un autre membre rédige');
select pg_temp.as_user('ea200000-0000-4000-8000-000000000001');
select is((select (public.conversation_reply('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a3'), 'Réponse du détenteur du bail.', 'reply-key-0013') ->> 'duplicate')::boolean), false, 'le détenteur du bail répond');
reset role;
select is((select lock_owner is null and lock_expires_at is null from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a3'), true, 'l''envoi libère le bail de son auteur');
-- expiration : un bail échu ne bloque plus
select pg_temp.as_user('ea200000-0000-4000-8000-000000000001');
select public.conversation_lock_acquire('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a3'));
reset role;
update public.conversations set lock_expires_at = now() - interval '1 minute' where contact_id = 'ec200000-0000-4000-8000-0000000000a3';
select pg_temp.as_user('ea200000-0000-4000-8000-000000000002');
select is((select public.conversation_lock_acquire('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a3')) ->> 'status'), 'acquired', 'un bail expiré est repris par un autre membre');
select public.conversation_lock_release('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a3'));
reset role;
select is((select lock_owner is null from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a3'), true, 'on rend son propre bail');
-- un commercial ne prend pas le bail d'un fil qui n'est pas le sien ; marketing : interdit
select pg_temp.as_user('ea200000-0000-4000-8000-000000000007');
select throws_ok($$select public.conversation_lock_acquire('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a1'))$$, 'PT404', 'not_found', 'bail sur le fil d''un autre commercial : introuvable');
select pg_temp.as_user('ea200000-0000-4000-8000-000000000003');
select throws_ok($$select public.conversation_lock_acquire('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a1'))$$, '42501', 'forbidden', 'marketing ne prend pas de bail');
reset role;

-- état du verrou (lecture seule : ne prend aucun bail)
select pg_temp.as_user('ea200000-0000-4000-8000-000000000001');
select public.conversation_lock_acquire('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a2'));
select is((select public.conversation_lock_status('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a2')) ->> 'lock'), 'mine', 'état : mon bail');
select pg_temp.as_user('ea200000-0000-4000-8000-000000000002');
select is((select public.conversation_lock_status('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a2')) ->> 'lock'), 'other', 'état : le bail d''un autre (sans savoir qui)');
select is((select public.conversation_lock_status('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a3')) ->> 'lock'), 'none', 'état : fil libre');
select pg_temp.as_user('ea200000-0000-4000-8000-000000000001');
select public.conversation_lock_release('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a2'));
reset role;

-- ---------------------------------------------------------------------------
-- Exclusion IA / humain : jamais les deux en même temps
-- ---------------------------------------------------------------------------
select pg_temp.as_user('ea200000-0000-4000-8000-000000000001');
select public.conversation_lock_acquire('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a2'));
select pg_temp.as_service();
select is((select public.conversation_ai_claim('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a2')) ->> 'status'), 'busy', 'l''IA ne prend pas le fil pendant qu''un humain rédige');
reset role;
select pg_temp.as_user('ea200000-0000-4000-8000-000000000001');
select public.conversation_lock_release('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a2'));
select pg_temp.as_service();
select is((select public.conversation_ai_claim('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a2')) ->> 'status'), 'claimed', 'l''IA prend le fil quand aucun humain ne rédige');
select is((select public.conversation_ai_claim('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a2')) ->> 'status'), 'already', 'prendre deux fois est sans effet');
reset role;
select pg_temp.as_user('ea200000-0000-4000-8000-000000000001');
select is((select public.conversation_lock_acquire('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a2')) ->> 'status'), 'ai', 'un humain ne prend pas le bail d''un fil tenu par l''IA');
select throws_ok($$select public.conversation_reply('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a2'), 'En même temps que l''IA', 'reply-key-0014')$$, 'P0001', 'conversation_locked', 'aucune réponse humaine tant que l''IA tient le fil');
select public.conversation_take_over('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a2'));
reset role;
select is((select handled_by from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a2'), 'human', 'l''humain reprend la main sur le fil');
select pg_temp.as_user('ea200000-0000-4000-8000-000000000001');
select is((select (public.conversation_reply('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a2'), 'Après la reprise en main.', 'reply-key-0015') ->> 'duplicate')::boolean), false, 'la réponse redevient possible');
reset role;

-- ---------------------------------------------------------------------------
-- Chaîne d'envoi du worker : approbateur commercial et consentement conversationnel d'une réponse
-- ---------------------------------------------------------------------------
select is((select private.message_send_claim('eb200000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 'reply-key-0001')) #>> '{message,approver_valid}'), 'true', 'worker : un commercial responsable est un approbateur valide pour une réponse');
select is((select private.message_send_claim('eb200000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 'reply-key-0006')) ->> 'consent'), 'true', 'worker : un message entrant récent du contact couvre la réponse');
select is((select private.message_send_claim('eb200000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 'reply-key-0013')) ->> 'consent'), 'false', 'worker : un seul message entrant vieux de 40 jours ne couvre plus la réponse');
-- le commercial n'est plus responsable : son approbation n'est plus valable
select pg_temp.as_user('ea200000-0000-4000-8000-000000000001');
select public.assign_conversation('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a5'), 'ea200000-0000-4000-8000-000000000004');
reset role;
select pg_temp.as_user('ea200000-0000-4000-8000-000000000004');
select public.conversation_reply('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a5'), 'Réponse du nouveau responsable.', 'reply-key-0016');
select pg_temp.as_user('ea200000-0000-4000-8000-000000000001');
select public.assign_conversation('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a5'), 'ea200000-0000-4000-8000-000000000007');
reset role;
select is((select private.message_send_claim('eb200000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 'reply-key-0016')) #>> '{message,approver_valid}'), 'false', 'worker : le commercial qui n''est plus responsable n''est plus un approbateur valide');
-- une autre finalité exige toujours un consentement enregistré (rien n'a changé pour le marketing)
select private.message_record('eb200000-0000-4000-8000-00000000000a', (select id from public.conversations where contact_id = 'ec200000-0000-4000-8000-0000000000a1'), 'outbound', null, 'Offre promotionnelle', 'promo-key-00001', null);
select pg_temp.as_user('ea200000-0000-4000-8000-000000000001');
select public.message_approve('eb200000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 'promo-key-00001'), 'marketing');
reset role;
select is((select private.message_send_claim('eb200000-0000-4000-8000-00000000000a', (select id from public.messages where idempotency_key = 'promo-key-00001')) ->> 'consent'), 'false', 'worker : la finalité « marketing » exige toujours un consentement enregistré');

select * from finish();
rollback;
