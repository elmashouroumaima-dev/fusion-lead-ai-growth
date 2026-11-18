-- Checkpoint C3 (J41) : prépare l'entreprise Alpha pour le test sur comptes d'essai RÉELS, après avoir créé les intégrations avec l'application
-- (e-mail : `POST /api/integrations` ; WhatsApp : écran Intégrations, « Connecter un numéro WhatsApp »). L'application ne sait pas encore créer
-- de canal (écart n°2 de docs/checkpoints/C3.md) : ce script le fait, comme les tests d'acceptation.
--
-- Il : (1) active l'intégration e-mail (la vérification de connexion ne gère que WhatsApp), (2) crée un canal e-mail et un canal WhatsApp,
-- (3) crée UN contact de test (VOTRE adresse et VOTRE téléphone de test) avec un consentement « service » par canal, (4) ouvre une conversation
-- par canal et, pour l'e-mail, y dépose un message ENTRANT (la boîte de réception ne répond qu'à un message reçu : consentement conversationnel).
--
--   docker exec -i supabase_db_fusion-leap psql -U postgres -v ON_ERROR_STOP=1 \
--     -v mail_account='<identifiant du compte e-mail de l'intégration>' -v mail_sender='ventes@<votre-domaine>' \
--     -v wa_account='<Phone number ID>' -v wa_sender='<numéro WhatsApp de test, ex. +15550783881>' \
--     -v tester_name='Testeur C3' -v tester_email='<votre adresse de test>' -v tester_phone='<votre téléphone de test, E.164>' \
--     < docs/testing/fixtures/c3-setup.sql
--
-- Seules des adresses et des numéros de TEST vous appartenant. Refuse de s'exécuter deux fois pour le même contact (e-mail déjà présent).
\set org 'a0000000-0000-4000-8000-0000000000a1'
begin;
-- psql ne remplace pas ses variables dans un bloc $$ ... $$ : on les passe au bloc par des paramètres de session (limités à la transaction)
select set_config('c3.org', :'org', true), set_config('c3.mail_account', :'mail_account', true), set_config('c3.mail_sender', :'mail_sender', true),
       set_config('c3.wa_account', :'wa_account', true), set_config('c3.wa_sender', :'wa_sender', true), set_config('c3.tester_name', :'tester_name', true),
       set_config('c3.tester_email', :'tester_email', true), set_config('c3.tester_phone', :'tester_phone', true);

do $$
declare
  v_org constant uuid := current_setting('c3.org')::uuid;
  v_mail_int uuid;
  v_wa_int uuid;
  v_mail_ch uuid;
  v_wa_ch uuid;
  v_contact uuid;
  v_conv_mail uuid;
  v_conv_wa uuid;
begin
  select id into v_mail_int from public.integrations where organization_id = v_org and provider = 'email' and external_account_id = current_setting('c3.mail_account');
  if v_mail_int is null then raise exception 'intégration e-mail introuvable pour le compte « % » : la créer d''abord (POST /api/integrations)', current_setting('c3.mail_account'); end if;
  select id into v_wa_int from public.integrations where organization_id = v_org and provider = 'whatsapp' and external_account_id = current_setting('c3.wa_account');
  if v_wa_int is null then raise exception 'intégration WhatsApp introuvable pour le numéro « % » : la connecter d''abord par l''écran Intégrations', current_setting('c3.wa_account'); end if;
  if exists (select 1 from public.contacts where organization_id = v_org and email_normalized = lower(current_setting('c3.tester_email'))) then
    raise exception 'contact de test déjà présent pour cette adresse : script déjà exécuté';
  end if;

  update public.integrations set status = 'active' where id = v_mail_int;
  insert into public.channels (organization_id, type, integration_id, sender_identity, status) values (v_org, 'email', v_mail_int, current_setting('c3.mail_sender'), 'active') returning id into v_mail_ch;
  insert into public.channels (organization_id, type, integration_id, sender_identity, status) values (v_org, 'whatsapp', v_wa_int, current_setting('c3.wa_sender'), 'active') returning id into v_wa_ch;

  insert into public.contacts (organization_id, name, email_raw, email_normalized, phone_e164)
    values (v_org, current_setting('c3.tester_name'), current_setting('c3.tester_email'), lower(current_setting('c3.tester_email')), current_setting('c3.tester_phone')) returning id into v_contact;
  insert into public.consent_events (organization_id, contact_id, channel, purpose, source) values
    (v_org, v_contact, 'email', 'service', 'manual'), (v_org, v_contact, 'whatsapp', 'service', 'manual');

  v_conv_mail := (private.conversation_get_or_create(v_org, v_contact, v_mail_ch) ->> 'id')::uuid;
  v_conv_wa := (private.conversation_get_or_create(v_org, v_contact, v_wa_ch) ->> 'id')::uuid;
  perform private.message_record(v_org, v_conv_mail, 'inbound', 'c3-seed-' || gen_random_uuid()::text, 'Bonjour, ceci est un message de test pour le checkpoint C3.', null, now() - interval '5 minutes');

  raise notice 'canal e-mail %, canal WhatsApp %, contact %, conversations % et %', v_mail_ch, v_wa_ch, v_contact, v_conv_mail, v_conv_wa;
end
$$;

commit;
