-- Retour arrière de 20261205100000_whatsapp_inbound.sql (J35). Les messages et statuts déjà enregistrés restent.
begin;
drop function if exists public.whatsapp_status_apply(uuid, uuid, text, text, integer, timestamptz);
drop function if exists public.whatsapp_inbound_apply(uuid, uuid, text, text, text, text, timestamptz);
drop function if exists private.whatsapp_status_apply(uuid, uuid, text, text, integer, timestamptz);
drop function if exists private.whatsapp_inbound_apply(uuid, uuid, text, text, text, text, timestamptz);
-- la garde `private.messages_guard` redevient celle du J31 : rejouer la fonction de 20261201100000_send_chain.sql si besoin.
commit;
