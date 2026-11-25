-- Retour arrière de 20261226100000_s11_secrets_reencrypt.sql : supprime les deux fonctions de rechiffrement. Les secrets déjà rechiffrés restent lisibles (ils sont chiffrés avec la clé courante).
drop function if exists public.secret_reencrypted(uuid, integer, text, text, text, integer, text);
drop function if exists public.secrets_reencrypt_due(integer, integer);
drop function if exists private.secret_reencrypted(uuid, integer, text, text, text, integer, text);
drop function if exists private.secrets_reencrypt_due(integer, integer);
