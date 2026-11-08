-- J18 — Contacts et consentement : structure, droits, contraintes, unicité, rôles, consentement dérivé, append-only, quota, audit.
-- Fixtures créées sous le propriétaire ; appels d'API sous les rôles concernés. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(111);

-- U1 owner A · U2 admin A · U3 marketing A · U4 sales A · U5 analyst A · U6 owner B · U7 sans adhésion · U8 retiré de A
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
  select ('8a000000-0000-4000-8000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'u' || n || '@cc.test', now()
    from generate_series(1, 8) n;
insert into public.organizations (id, name, slug) values
  ('8b000000-0000-4000-8000-00000000000a', 'CC Alpha', 'cc-alpha-test'),
  ('8b000000-0000-4000-8000-00000000000b', 'CC Beta', 'cc-beta-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('8b000000-0000-4000-8000-00000000000a', '8a000000-0000-4000-8000-000000000001', 'company_owner', 'active'),
  ('8b000000-0000-4000-8000-00000000000a', '8a000000-0000-4000-8000-000000000002', 'company_admin', 'active'),
  ('8b000000-0000-4000-8000-00000000000a', '8a000000-0000-4000-8000-000000000003', 'marketing_manager', 'active'),
  ('8b000000-0000-4000-8000-00000000000a', '8a000000-0000-4000-8000-000000000004', 'sales_agent', 'active'),
  ('8b000000-0000-4000-8000-00000000000a', '8a000000-0000-4000-8000-000000000005', 'analyst', 'active'),
  ('8b000000-0000-4000-8000-00000000000a', '8a000000-0000-4000-8000-000000000008', 'marketing_manager', 'removed'),
  ('8b000000-0000-4000-8000-00000000000b', '8a000000-0000-4000-8000-000000000006', 'company_owner', 'active');
-- Alpha : « starter » (5 000 contacts) ; Beta : « trial » (500 contacts)
insert into public.subscriptions (organization_id, plan_id, status) values
  ('8b000000-0000-4000-8000-00000000000a', (select id from public.plans where code = 'starter'), 'active'),
  ('8b000000-0000-4000-8000-00000000000b', (select id from public.plans where code = 'trial'), 'trial');
-- Fixtures : K1 (e-mail + téléphone) et K2 (téléphone seul) chez Alpha ; K3 chez Beta (même e-mail que K1).
insert into public.contacts (id, organization_id, name, email_raw, email_normalized, phone_e164) values
  ('8c000000-0000-4000-8000-0000000000a1', '8b000000-0000-4000-8000-00000000000a', 'Karim', 'Karim@Exemple.ma', 'karim@exemple.ma', '+212612345678'),
  ('8c000000-0000-4000-8000-0000000000a2', '8b000000-0000-4000-8000-00000000000a', 'Layla', null, null, '+966501234567'),
  ('8c000000-0000-4000-8000-0000000000b1', '8b000000-0000-4000-8000-00000000000b', 'Karim chez Beta', 'karim@exemple.ma', 'karim@exemple.ma', null);

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $f$;
grant execute on function pg_temp.as_user(text) to public;

-- 1. Structure et droits ---------------------------------------------------------------------------------------------
select has_table('public', 'contacts', 'contacts existe');
select has_table('public', 'consent_events', 'consent_events existe');
select ok((select relrowsecurity from pg_class where oid = 'public.contacts'::regclass), 'RLS activée sur contacts');
select ok((select relrowsecurity from pg_class where oid = 'public.consent_events'::regclass), 'RLS activée sur consent_events');
select is(enum_range(null::public.channel_type)::text[], array['email', 'whatsapp'], 'canaux : email, whatsapp');
select is(enum_range(null::public.consent_status)::text[], array['unknown', 'granted', 'revoked'], 'statuts de consentement');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'contacts'), 1, 'contacts : une seule politique (lecture)');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'consent_events'), 1, 'consent_events : une seule politique (lecture)');
select ok(not has_table_privilege('authenticated', 'public.contacts', 'insert,update,delete,truncate'), 'authenticated : aucune écriture directe sur contacts');
select ok(not has_table_privilege('authenticated', 'public.consent_events', 'insert,update,delete,truncate'), 'authenticated : aucune écriture directe sur consent_events');
select ok(not has_table_privilege('service_role', 'public.contacts', 'insert,update,delete,truncate'), 'service_role : aucune écriture directe sur contacts');
select ok(not has_table_privilege('service_role', 'public.consent_events', 'insert,update,delete,truncate'), 'service_role : aucune écriture directe sur consent_events');
select ok(not has_table_privilege('anon', 'public.contacts', 'select,insert,update,delete'), 'anon : aucun droit sur contacts');
select ok(not has_table_privilege('anon', 'public.consent_events', 'select,insert,update,delete'), 'anon : aucun droit sur consent_events');
select ok(not has_function_privilege('anon', 'public.create_contact(uuid, text, text, text, text, text, text, text, text, jsonb)', 'execute'), 'anon : create_contact non exécutable');
select ok(not has_function_privilege('service_role', 'public.record_consent(uuid, uuid, public.channel_type, text, text, jsonb)', 'execute'), 'service_role : record_consent non exécutable');
select ok(not has_function_privilege('authenticated', 'private.refresh_consent_status(uuid, uuid)', 'execute'), 'authenticated : refresh_consent_status non exécutable');

-- 2. Contraintes (sous le propriétaire : seule la base juge) ------------------------------------------------------------
select throws_ok($$insert into public.contacts (organization_id, name) values ('8b000000-0000-4000-8000-00000000000a', 'Sans identifiant')$$, '23514', null, 'ni e-mail ni téléphone : refusé');
select throws_ok($$insert into public.contacts (organization_id, email_raw, email_normalized) values ('8b000000-0000-4000-8000-00000000000a', 'A@x.com', 'autre@x.com')$$, '23514', null, 'e-mail normalisé incohérent avec la saisie : refusé');
select throws_ok($$insert into public.contacts (organization_id, email_raw, email_normalized) values ('8b000000-0000-4000-8000-00000000000a', 'pas-un-email', 'pas-un-email')$$, '23514', null, 'e-mail sans arobase refusé');
select throws_ok($$insert into public.contacts (organization_id, email_raw, email_normalized) values ('8b000000-0000-4000-8000-00000000000a', 'a..b@x.com', 'a..b@x.com')$$, '23514', null, 'e-mail avec deux points consécutifs refusé');
select throws_ok($$insert into public.contacts (organization_id, email_raw, email_normalized) values ('8b000000-0000-4000-8000-00000000000a', 'é@x.com', 'é@x.com')$$, '23514', null, 'e-mail non ASCII refusé');
select throws_ok($$insert into public.contacts (organization_id, email_raw) values ('8b000000-0000-4000-8000-00000000000a', 'a@x.com')$$, '23514', null, 'e-mail saisi sans e-mail normalisé refusé');
select lives_ok($$insert into public.contacts (organization_id, email_raw, email_normalized) values ('8b000000-0000-4000-8000-00000000000a', 'O''Brien+x@Sous.Exemple.com', 'o''brien+x@sous.exemple.com')$$, 'e-mail avec apostrophe et plus : accepté');
select throws_ok($$insert into public.contacts (organization_id, phone_e164) values ('8b000000-0000-4000-8000-00000000000a', '0612345678')$$, '23514', null, 'téléphone non E.164 refusé');
select throws_ok($$insert into public.contacts (organization_id, phone_e164) values ('8b000000-0000-4000-8000-00000000000a', '+0123456789')$$, '23514', null, 'téléphone commençant par 0 après + refusé');
select throws_ok($$insert into public.contacts (organization_id, phone_e164) values ('8b000000-0000-4000-8000-00000000000a', '+1234567890123456')$$, '23514', null, 'téléphone trop long refusé');
select throws_ok($$insert into public.contacts (organization_id, phone_e164, name) values ('8b000000-0000-4000-8000-00000000000a', '+212600000001', ' espace')$$, '23514', null, 'nom avec espace en bordure refusé');
select throws_ok($$insert into public.contacts (organization_id, phone_e164, language) values ('8b000000-0000-4000-8000-00000000000a', '+212600000001', 'fra')$$, '23514', null, 'langue sur 3 lettres refusée');
select throws_ok($$insert into public.contacts (organization_id, phone_e164, country) values ('8b000000-0000-4000-8000-00000000000a', '+212600000001', 'ma')$$, '23514', null, 'pays en minuscules refusé');
select throws_ok($$insert into public.contacts (organization_id, phone_e164, external_source) values ('8b000000-0000-4000-8000-00000000000a', '+212600000001', 'salla')$$, '23514', null, 'source externe sans identifiant refusée');
select throws_ok($$insert into public.contacts (organization_id, phone_e164, attributes) values ('8b000000-0000-4000-8000-00000000000a', '+212600000001', '[]')$$, '23514', null, 'attributs : un tableau est refusé');
select throws_ok($$insert into public.contacts (organization_id, phone_e164, attributes) values ('8b000000-0000-4000-8000-00000000000a', '+212600000001', '{"a": {"b": 1}}')$$, '23514', null, 'attributs : objet imbriqué refusé');
select throws_ok($$insert into public.contacts (organization_id, phone_e164, attributes) values ('8b000000-0000-4000-8000-00000000000a', '+212600000001', jsonb_build_object('k', repeat('a', 9000)))$$, '23514', null, 'attributs de plus de 8 Ko refusés');

-- 3. Unicité : même e-mail / téléphone / identifiant externe dans UNE entreprise = refusé ; entre entreprises = deux contacts
select throws_ok($$insert into public.contacts (organization_id, email_raw, email_normalized) values ('8b000000-0000-4000-8000-00000000000a', 'KARIM@exemple.ma', 'karim@exemple.ma')$$, '23505', null, 'même e-mail dans la même entreprise : refusé');
select throws_ok($$insert into public.contacts (organization_id, phone_e164) values ('8b000000-0000-4000-8000-00000000000a', '+966501234567')$$, '23505', null, 'même téléphone dans la même entreprise : refusé');
select lives_ok($$insert into public.contacts (organization_id, phone_e164, external_source, external_id) values ('8b000000-0000-4000-8000-00000000000a', '+212600000002', 'salla', '42')$$, 'identifiant externe : accepté une fois');
select throws_ok($$insert into public.contacts (organization_id, phone_e164, external_source, external_id) values ('8b000000-0000-4000-8000-00000000000a', '+212600000003', 'salla', '42')$$, '23505', null, 'même identifiant externe : refusé');
select is((select count(*)::int from public.contacts where email_normalized = 'karim@exemple.ma'), 2, 'même e-mail dans deux entreprises : deux contacts');
select lives_ok($$insert into public.contacts (organization_id, phone_e164) values ('8b000000-0000-4000-8000-00000000000b', '+966501234567')$$, 'même téléphone chez Beta : accepté');
select throws_ok($$update public.contacts set organization_id = '8b000000-0000-4000-8000-00000000000b' where id = '8c000000-0000-4000-8000-0000000000a2'$$, null, null, 'organization_id est immuable');
select throws_ok($$insert into public.consent_events (organization_id, contact_id, channel, purpose, source) values ('8b000000-0000-4000-8000-00000000000b', '8c000000-0000-4000-8000-0000000000a1', 'email', 'marketing', 'manual')$$, '23503', null, 'consentement visant le contact d''une autre entreprise : refusé (FK composite)');
select throws_ok($$insert into public.consent_events (organization_id, contact_id, channel, purpose, source) values ('8b000000-0000-4000-8000-00000000000a', '8c000000-0000-4000-8000-0000000000a1', 'email', 'Marketing', 'manual')$$, '23514', null, 'finalité mal formée refusée');
select throws_ok($$insert into public.consent_events (organization_id, contact_id, channel, purpose, source, proof) values ('8b000000-0000-4000-8000-00000000000a', '8c000000-0000-4000-8000-0000000000a1', 'email', 'marketing', 'manual', '{"cookie": "x"}')$$, '23514', null, 'preuve : clé inconnue refusée');
select throws_ok($$insert into public.consent_events (organization_id, contact_id, channel, purpose, source, proof) values ('8b000000-0000-4000-8000-00000000000a', '8c000000-0000-4000-8000-0000000000a1', 'email', 'marketing', 'manual', '{"url": "http://exemple.ma"}')$$, '23514', null, 'preuve : URL http refusée');

-- 4. Lecture : owner, admin et marketing seulement ----------------------------------------------------------------------
select pg_temp.as_user('8a000000-0000-4000-8000-000000000001');
select is((select count(*)::int from public.contacts), 4, 'owner d''Alpha : voit les contacts d''Alpha seulement');
select pg_temp.as_user('8a000000-0000-4000-8000-000000000003');
select is((select count(*)::int from public.contacts), 4, 'marketing d''Alpha : lecture autorisée');
select pg_temp.as_user('8a000000-0000-4000-8000-000000000004');
select is((select count(*)::int from public.contacts), 0, 'commercial : aucun accès (jusqu''aux leads, J19)');
select pg_temp.as_user('8a000000-0000-4000-8000-000000000005');
select is((select count(*)::int from public.contacts), 0, 'analyste : aucun accès (données personnelles)');
select pg_temp.as_user('8a000000-0000-4000-8000-000000000006');
select is((select count(*)::int from public.contacts where email_normalized = 'karim@exemple.ma'), 1, 'owner de Beta : voit uniquement son Karim');
select pg_temp.as_user('8a000000-0000-4000-8000-000000000007');
select is((select count(*)::int from public.contacts), 0, 'sans adhésion : rien');
select pg_temp.as_user('8a000000-0000-4000-8000-000000000008');
select is((select count(*)::int from public.contacts), 0, 'membre retiré : rien');
reset role;

-- 5. Écriture par fonctions : rôles ------------------------------------------------------------------------------------
select pg_temp.as_user('8a000000-0000-4000-8000-000000000003');
select lives_ok($$select public.create_contact('8b000000-0000-4000-8000-00000000000a', 'Marketing crée', 'm1@x.com', 'm1@x.com', '+212611111111', 'fr', 'MA', null, null, '{"ville": "Rabat"}')$$, 'marketing : crée un contact');
select pg_temp.as_user('8a000000-0000-4000-8000-000000000002');
select lives_ok($$select public.create_contact('8b000000-0000-4000-8000-00000000000a', null, null, null, '+212622222222', null, null, null, null, '{}')$$, 'admin : crée un contact téléphone seul, sans nom');
select pg_temp.as_user('8a000000-0000-4000-8000-000000000004');
select throws_ok($$select public.create_contact('8b000000-0000-4000-8000-00000000000a', 'x', null, null, '+212633333333', null, null, null, null, '{}')$$, '42501', null, 'commercial : création refusée');
select pg_temp.as_user('8a000000-0000-4000-8000-000000000005');
select throws_ok($$select public.create_contact('8b000000-0000-4000-8000-00000000000a', 'x', null, null, '+212633333333', null, null, null, null, '{}')$$, '42501', null, 'analyste : création refusée');
select pg_temp.as_user('8a000000-0000-4000-8000-000000000006');
select throws_ok($$select public.create_contact('8b000000-0000-4000-8000-00000000000a', 'x', null, null, '+212633333333', null, null, null, null, '{}')$$, '42501', null, 'owner de Beta : création chez Alpha refusée');
select throws_ok($$select public.update_contact('8b000000-0000-4000-8000-00000000000a', '8c000000-0000-4000-8000-0000000000a1', 'piraté', null, null, '+212699999999', null, null, null, null, '{}')$$, '42501', null, 'owner de Beta : modification chez Alpha refusée');
select pg_temp.as_user('8a000000-0000-4000-8000-000000000007');
select throws_ok($$select public.create_contact('8b000000-0000-4000-8000-00000000000a', 'x', null, null, '+212633333333', null, null, null, null, '{}')$$, '42501', null, 'sans adhésion : création refusée');
select pg_temp.as_user('8a000000-0000-4000-8000-000000000008');
select throws_ok($$select public.create_contact('8b000000-0000-4000-8000-00000000000a', 'x', null, null, '+212633333333', null, null, null, null, '{}')$$, '42501', null, 'membre retiré : création refusée');
reset role;
select set_config('request.jwt.claims', '', true);
select throws_ok($$select public.create_contact('8b000000-0000-4000-8000-00000000000a', 'x', null, null, '+212633333333', null, null, null, null, '{}')$$, '28000', null, 'sans identité : unauthenticated');

-- 6. Modification --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('8a000000-0000-4000-8000-000000000001');
select lives_ok($$select public.update_contact('8b000000-0000-4000-8000-00000000000a', '8c000000-0000-4000-8000-0000000000a1', 'Karim B.', 'Karim@Exemple.ma', 'karim@exemple.ma', '+212612345678', 'fr', 'MA', null, null, '{}')$$, 'owner : modifie un contact');
select throws_ok($$select public.update_contact('8b000000-0000-4000-8000-00000000000a', '8c000000-0000-4000-8000-0000000000a1', 'x', null, null, '+966501234567', null, null, null, null, '{}')$$, '23505', null, 'modification vers le téléphone d''un autre contact : refusée');
select throws_ok($$select public.update_contact('8b000000-0000-4000-8000-00000000000a', '8c000000-0000-4000-8000-0000000000b1', 'x', null, null, '+212677777777', null, null, null, null, '{}')$$, 'PT404', null, 'contact d''une autre entreprise : introuvable');
select throws_ok($$select public.update_contact('8b000000-0000-4000-8000-00000000000a', null, 'x', null, null, '+212677777777', null, null, null, null, '{}')$$, '22023', null, 'identifiant absent : validation_failed');
select is((select name from public.contacts where id = '8c000000-0000-4000-8000-0000000000a1'), 'Karim B.', 'le nom a changé');
reset role;

-- 7. Consentement : enregistrement, statut dérivé, idempotence, révocation ----------------------------------------------
select pg_temp.as_user('8a000000-0000-4000-8000-000000000003');
select is((select consent_status::text from public.contacts where id = '8c000000-0000-4000-8000-0000000000a1'), 'unknown', 'contact sans consentement : unknown');
select lives_ok($$select public.record_consent('8b000000-0000-4000-8000-00000000000a', '8c000000-0000-4000-8000-0000000000a1', 'email', 'marketing', 'web_form', '{"consent_text": "J''accepte.", "consent_version": "v2", "ip": "203.0.113.7", "url": "https://exemple.ma/inscription"}')$$, 'marketing : enregistre un consentement');
select is((select consent_status::text from public.contacts where id = '8c000000-0000-4000-8000-0000000000a1'), 'granted', 'après consentement : granted');
select is((select public.record_consent('8b000000-0000-4000-8000-00000000000a', '8c000000-0000-4000-8000-0000000000a1', 'email', 'marketing', 'manual', '{}') = (select id from public.consent_events where contact_id = '8c000000-0000-4000-8000-0000000000a1' and revoked_at is null)), true, 'même canal et finalité déjà actifs : renvoie l''événement existant');
select is((select count(*)::int from public.consent_events where contact_id = '8c000000-0000-4000-8000-0000000000a1'), 1, 'aucun doublon d''événement');
select lives_ok($$select public.record_consent('8b000000-0000-4000-8000-00000000000a', '8c000000-0000-4000-8000-0000000000a1', 'whatsapp', 'marketing', 'manual', '{}')$$, 'autre canal : nouvel événement');
select throws_ok($$select public.record_consent('8b000000-0000-4000-8000-00000000000a', '8c000000-0000-4000-8000-0000000000b1', 'email', 'marketing', 'manual', '{}')$$, 'PT404', null, 'consentement sur le contact d''une autre entreprise : introuvable');
select throws_ok($$select public.record_consent('8b000000-0000-4000-8000-00000000000a', '8c000000-0000-4000-8000-0000000000a1', 'email', 'Marketing', 'manual', '{}')$$, '23514', null, 'finalité mal formée : refusée');
select is((select public.revoke_consent('8b000000-0000-4000-8000-00000000000a', '8c000000-0000-4000-8000-0000000000a1', 'email', 'marketing', false)), 1, 'révocation e-mail marketing : 1 événement révoqué');
select is((select consent_status::text from public.contacts where id = '8c000000-0000-4000-8000-0000000000a1'), 'granted', 'WhatsApp encore actif : granted');
select is((select public.revoke_consent('8b000000-0000-4000-8000-00000000000a', '8c000000-0000-4000-8000-0000000000a1', 'whatsapp', null, true)), 1, 'révocation WhatsApp (toutes finalités) avec ne-plus-contacter');
select is((select consent_status::text from public.contacts where id = '8c000000-0000-4000-8000-0000000000a1'), 'revoked', 'tout révoqué : revoked');
select is((select do_not_contact from public.contacts where id = '8c000000-0000-4000-8000-0000000000a1'), true, 'do_not_contact posé immédiatement');
select is((select public.revoke_consent('8b000000-0000-4000-8000-00000000000a', '8c000000-0000-4000-8000-0000000000a1', 'email', null, false)), 0, 'rien à révoquer : 0, sans erreur');
select throws_ok($$select public.set_do_not_contact('8b000000-0000-4000-8000-00000000000a', '8c000000-0000-4000-8000-0000000000a1', false)$$, '42501', null, 'marketing : ne peut PAS retirer ne-plus-contacter');
select lives_ok($$select public.set_do_not_contact('8b000000-0000-4000-8000-00000000000a', '8c000000-0000-4000-8000-0000000000a2', true)$$, 'marketing : peut poser ne-plus-contacter');
select pg_temp.as_user('8a000000-0000-4000-8000-000000000004');
select throws_ok($$select public.record_consent('8b000000-0000-4000-8000-00000000000a', '8c000000-0000-4000-8000-0000000000a1', 'email', 'marketing', 'manual', '{}')$$, '42501', null, 'commercial : enregistrement refusé');
select throws_ok($$select public.revoke_consent('8b000000-0000-4000-8000-00000000000a', '8c000000-0000-4000-8000-0000000000a1', 'email', null, true)$$, '42501', null, 'commercial : révocation refusée (jusqu''aux leads, J19)');
select pg_temp.as_user('8a000000-0000-4000-8000-000000000001');
select lives_ok($$select public.set_do_not_contact('8b000000-0000-4000-8000-00000000000a', '8c000000-0000-4000-8000-0000000000a2', false)$$, 'owner : peut retirer ne-plus-contacter');
reset role;

-- 8. Historique append-only ------------------------------------------------------------------------------------------------
select throws_ok($$delete from public.consent_events where contact_id = '8c000000-0000-4000-8000-0000000000a1'$$, '23514', null, 'suppression d''un consentement : refusée');
select throws_ok($$update public.consent_events set purpose = 'autre' where contact_id = '8c000000-0000-4000-8000-0000000000a1'$$, '23514', null, 'modification de la finalité : refusée');
select throws_ok($$update public.consent_events set revoked_at = null where contact_id = '8c000000-0000-4000-8000-0000000000a1'$$, '23514', null, 'une révocation ne peut pas être annulée');
select throws_ok($$update public.consent_events set proof = '{}' where contact_id = '8c000000-0000-4000-8000-0000000000a1'$$, '23514', null, 'la preuve ne se modifie pas');

-- 9. Quota « contacts » -------------------------------------------------------------------------------------------------
insert into public.contacts (organization_id, phone_e164)
  select '8b000000-0000-4000-8000-00000000000b', '+2127' || lpad(n::text, 8, '0') from generate_series(1, 497) n;
select pg_temp.as_user('8a000000-0000-4000-8000-000000000006');
select lives_ok($$select public.create_contact('8b000000-0000-4000-8000-00000000000b', 'Dernier', null, null, '+212800000001', null, null, null, null, '{}')$$, 'Beta : le 500e contact passe');
select throws_ok($$select public.create_contact('8b000000-0000-4000-8000-00000000000b', 'Un de trop', null, null, '+212800000002', null, null, null, null, '{}')$$, 'P0001', 'quota_exceeded', 'Beta : le 501e contact est refusé (quota)');
reset role;
select is((select count(*)::int from public.contacts where organization_id = '8b000000-0000-4000-8000-00000000000b'), 500, 'Beta : 500 contacts exactement');

-- 10. Audit : jamais d'identité ni de preuve --------------------------------------------------------------------------------
select is((select count(*)::int from public.audit_logs where action = 'contact.created' and organization_id = '8b000000-0000-4000-8000-00000000000a' and actor_kind = 'user'), 2, 'audit : contact.created (2 créations par les rôles)');
select is((select (after -> 'changed') from public.audit_logs where action = 'contact.updated' and entity_id = '8c000000-0000-4000-8000-0000000000a1' order by created_at desc limit 1), '["name", "language", "country"]'::jsonb, 'audit : contact.updated ne liste que les NOMS des champs');
select is((select count(*)::int from public.audit_logs where action = 'consent.recorded' and organization_id = '8b000000-0000-4000-8000-00000000000a'), 2, 'audit : consent.recorded (2 événements)');
select is((select count(*)::int from public.audit_logs where action = 'consent.revoked' and organization_id = '8b000000-0000-4000-8000-00000000000a'), 2, 'audit : consent.revoked (2 révocations)');
select is((select count(*)::int from public.audit_logs where action = 'contact.do_not_contact_changed' and entity_id = '8c000000-0000-4000-8000-0000000000a1'), 1, 'audit : contact.do_not_contact_changed');
select ok(not exists (
  select 1 from public.audit_logs
   where entity_type in ('contact', 'consent_event') and organization_id = '8b000000-0000-4000-8000-00000000000a'
     and (coalesce(before::text, '') || coalesce(after::text, '')) ~* '(karim|exemple\.ma|@|\+212|\+966|J''accepte|203\.0\.113)'
), 'audit : ni nom, ni e-mail, ni téléphone, ni preuve');

-- 11. Revue sécurité : identité d'un contact « ne plus contacter », consentement lié à l'adresse, plafonds, caractères ------
select pg_temp.as_user('8a000000-0000-4000-8000-000000000003');
select throws_ok($$select public.update_contact('8b000000-0000-4000-8000-00000000000a', '8c000000-0000-4000-8000-0000000000a1', 'Karim B.', 'karim@exemple.ma', 'karim@exemple.ma', '+212688888888', 'fr', 'MA', null, null, '{}')$$, '42501', null, 'marketing : ne peut pas changer le téléphone d''un contact « ne plus contacter »');
select throws_ok($$select public.update_contact('8b000000-0000-4000-8000-00000000000a', '8c000000-0000-4000-8000-0000000000a1', 'Karim B.', 'autre@exemple.ma', 'autre@exemple.ma', '+212612345678', 'fr', 'MA', null, null, '{}')$$, '42501', null, 'marketing : ne peut pas changer l''e-mail d''un contact « ne plus contacter »');
select lives_ok($$select public.update_contact('8b000000-0000-4000-8000-00000000000a', '8c000000-0000-4000-8000-0000000000a1', 'Karim renommé', 'karim@exemple.ma', 'karim@exemple.ma', '+212612345678', 'fr', 'MA', null, null, '{}')$$, 'marketing : peut encore changer le nom (identité inchangée)');
select pg_temp.as_user('8a000000-0000-4000-8000-000000000001');
select lives_ok($$select public.update_contact('8b000000-0000-4000-8000-00000000000a', '8c000000-0000-4000-8000-0000000000a1', 'Karim renommé', 'karim@exemple.ma', 'karim@exemple.ma', '+212688888888', 'fr', 'MA', null, null, '{}')$$, 'owner : peut changer le téléphone d''un contact « ne plus contacter »');
select set_config('t.c11', public.create_contact('8b000000-0000-4000-8000-00000000000a', 'Onze', 'e11@x.com', 'e11@x.com', '+212644444444', 'fr', 'MA', null, null, '{}')::text, true);
select public.record_consent('8b000000-0000-4000-8000-00000000000a', current_setting('t.c11')::uuid, 'email', 'marketing', 'manual', '{}');
select public.record_consent('8b000000-0000-4000-8000-00000000000a', current_setting('t.c11')::uuid, 'whatsapp', 'marketing', 'manual', '{}');
select public.update_contact('8b000000-0000-4000-8000-00000000000a', current_setting('t.c11')::uuid, 'Onze', 'e11b@x.com', 'e11b@x.com', '+212644444444', 'fr', 'MA', null, null, '{}');
select is((select count(*)::int from public.consent_events where contact_id = current_setting('t.c11')::uuid and channel = 'email' and revoked_at is null), 0, 'changement d''e-mail : le consentement e-mail est révoqué');
select is((select consent_status::text from public.contacts where id = current_setting('t.c11')::uuid), 'granted', 'le consentement WhatsApp (numéro inchangé) reste actif : granted');
select public.update_contact('8b000000-0000-4000-8000-00000000000a', current_setting('t.c11')::uuid, 'Onze', 'e11b@x.com', 'e11b@x.com', '+212655555555', 'fr', 'MA', null, null, '{}');
select is((select consent_status::text from public.contacts where id = current_setting('t.c11')::uuid), 'revoked', 'changement de téléphone : le consentement WhatsApp est révoqué aussi');
select throws_ok($$select public.record_consent('8b000000-0000-4000-8000-00000000000a', '8c000000-0000-4000-8000-0000000000a2', 'email', 'marketing', 'manual', '{}')$$, '22023', null, 'consentement e-mail sur un contact sans e-mail : refusé');
select set_config('t.c12', public.create_contact('8b000000-0000-4000-8000-00000000000a', 'Plafond', 'e12@x.com', 'e12@x.com', null, null, null, null, null, '{}')::text, true);
select lives_ok($$select public.record_consent('8b000000-0000-4000-8000-00000000000a', current_setting('t.c12')::uuid, 'email', 'finalite_' || n, 'manual', '{}') from generate_series(1, 50) n$$, '50 consentements sur un contact : acceptés');
select throws_ok($$select public.record_consent('8b000000-0000-4000-8000-00000000000a', current_setting('t.c12')::uuid, 'email', 'finalite_51', 'manual', '{}')$$, 'P0001', 'too_many_consents', 'le 51e consentement d''un contact est refusé');
reset role;
select throws_ok($$insert into public.contacts (organization_id, email_raw, email_normalized) values ('8b000000-0000-4000-8000-00000000000a', chr(8490) || 'evin@x.com', 'kevin@x.com')$$, '23514', null, 'e-mail saisi avec le signe Kelvin (hors ASCII) refusé');
select throws_ok($$insert into public.contacts (organization_id, phone_e164, attributes) values ('8b000000-0000-4000-8000-00000000000a', '+212600000009', jsonb_build_object('note', 'a' || chr(8238) || 'b'))$$, '23514', null, 'attribut : valeur avec caractère de direction refusée');
select throws_ok($$insert into public.contacts (organization_id, phone_e164, attributes) values ('8b000000-0000-4000-8000-00000000000a', '+212600000008', jsonb_build_object('cle' || chr(8238), 'ok'))$$, '23514', null, 'attribut : clé avec caractère de direction refusée');

select * from finish();
rollback;
