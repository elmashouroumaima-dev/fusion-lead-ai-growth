-- Checkpoint C3 : prépare le CONTACT de test et ses conversations, APRÈS avoir connecté les canaux depuis l'écran Intégrations
-- (e-mail : « Connecter un e-mail (Postmark) » ; WhatsApp : « Connecter un numéro WhatsApp »). Remplace c3-setup.sql, qui créait aussi les canaux
-- (c'est maintenant l'application qui le fait, et qui n'active un canal qu'après la vérification du fournisseur).
--
-- Il : (1) retrouve le canal e-mail par son adresse d'expéditeur (et, si donné, le canal WhatsApp par son numéro), exige qu'ils soient « active »,
-- (2) crée UN contact de test (VOTRE adresse et VOTRE téléphone de test) avec un consentement « service » par canal, (3) ouvre une conversation par
-- canal et, pour l'e-mail, y dépose un message ENTRANT (la boîte de réception ne répond qu'à un message reçu : consentement conversationnel).
--
--   docker exec -i supabase_db_fusion-leap psql -U postgres -v ON_ERROR_STOP=1 \
--     -v mail_sender='<adresse d''expéditeur du canal e-mail>' -v wa_sender='<numéro du canal WhatsApp, E.164, ou vide>' \
--     -v tester_name='Testeur C3' -v tester_email='<votre adresse de test>' -v tester_phone='<votre téléphone de test, E.164>' \
--     < docs/testing/fixtures/c3-contact.sql
--
-- Seules des adresses et des numéros de TEST vous appartenant. Refuse de s'exécuter deux fois pour le même contact (e-mail déjà présent).
\set org 'a0000000-0000-4000-8000-0000000000a1'
begin;
select set_config('c3.org', :'org', true), set_config('c3.mail_sender', :'mail_sender', true), set_config('c3.wa_sender', :'wa_sender', true),
       set_config('c3.tester_name', :'tester_name', true), set_config('c3.tester_email', :'tester_email', true), set_config('c3.tester_phone', :'tester_phone', true);

do $$
declare
  v_org constant uuid := current_setting('c3.org')::uuid;
  v_mail_ch uuid;
  v_wa_ch uuid;
  v_contact uuid;
  v_conv_mail uuid;
  v_conv_wa uuid;
begin
  select id into v_mail_ch from public.channels where organization_id = v_org and type = 'email' and sender_identity = current_setting('c3.mail_sender') and status = 'active';
  if v_mail_ch is null then raise exception 'canal e-mail « % » introuvable ou pas actif : le connecter et le vérifier depuis l''écran Intégrations', current_setting('c3.mail_sender'); end if;
  if current_setting('c3.wa_sender') <> '' then
    select id into v_wa_ch from public.channels where organization_id = v_org and type = 'whatsapp' and sender_identity = current_setting('c3.wa_sender') and status = 'active';
    if v_wa_ch is null then raise exception 'canal WhatsApp « % » introuvable ou pas actif : le connecter et le vérifier depuis l''écran Intégrations', current_setting('c3.wa_sender'); end if;
  end if;
  if exists (select 1 from public.contacts where organization_id = v_org and email_normalized = lower(current_setting('c3.tester_email'))) then
    raise exception 'contact de test déjà présent pour cette adresse : script déjà exécuté';
  end if;

  insert into public.contacts (organization_id, name, email_raw, email_normalized, phone_e164)
    values (v_org, current_setting('c3.tester_name'), current_setting('c3.tester_email'), lower(current_setting('c3.tester_email')),
            nullif(current_setting('c3.tester_phone'), '')) returning id into v_contact;
  insert into public.consent_events (organization_id, contact_id, channel, purpose, source) values (v_org, v_contact, 'email', 'service', 'manual');
  v_conv_mail := (private.conversation_get_or_create(v_org, v_contact, v_mail_ch) ->> 'id')::uuid;
  perform private.message_record(v_org, v_conv_mail, 'inbound', 'c3-seed-' || gen_random_uuid()::text, 'Bonjour, ceci est un message de test pour le checkpoint C3.', null, now() - interval '5 minutes');
  if v_wa_ch is not null then
    insert into public.consent_events (organization_id, contact_id, channel, purpose, source) values (v_org, v_contact, 'whatsapp', 'service', 'manual');
    v_conv_wa := (private.conversation_get_or_create(v_org, v_contact, v_wa_ch) ->> 'id')::uuid;
  end if;

  raise notice 'canal e-mail %, canal WhatsApp %, contact %, conversations % et %', v_mail_ch, v_wa_ch, v_contact, v_conv_mail, v_conv_wa;
end
$$;

commit;
