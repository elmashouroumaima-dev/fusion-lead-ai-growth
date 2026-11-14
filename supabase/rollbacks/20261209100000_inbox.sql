-- Retour arrière de 20261209100000_inbox.sql
-- Supprime la liste de la boîte de réception (l'écran Inbox cesse de fonctionner). Aucune donnée n'est touchée.

drop function if exists public.search_conversations(uuid, text, text, uuid, boolean, text, integer, integer, uuid);
