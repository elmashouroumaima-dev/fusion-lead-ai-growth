-- Retour arrière de 20261208100000_contacts_search.sql
-- Supprime la recherche paginée des contacts (la liste de l'écran Contacts cesse de fonctionner). Aucune donnée n'est touchée.

drop function if exists public.search_contacts(uuid, text, integer, integer);
