-- S-11 (revue de sécurité de la Phase 3, 2026-11-24) : le trousseau n'avait qu'une clé, donc une rotation de la clé maître rendait tous les secrets illisibles. Le serveur accepte maintenant
-- d'anciennes clés (`SECRETS_PREVIOUS_KEYS`) et un job du worker rechiffre les secrets avec la clé courante. Cette migration fournit les deux fonctions SQL du job :
--  * `private.secrets_reencrypt_due(version_courante, limite)` : secrets à rechiffrer = chiffrés avec une AUTRE version de clé, ou jeton / secret de webhook sans empreinte (S-12 : rattrapage
--    des secrets écrits avant l'empreinte). Le job déchiffre, rechiffre, recalcule l'empreinte (elle dépend de la clé courante), puis écrit.
--  * `private.secret_reencrypted(id, ancienne version, ancien chiffré, nouveau chiffré, nonce, version, empreinte)` : écrit le nouveau chiffré SEULEMENT si la ligne n'a pas changé depuis la
--    lecture (même version et même chiffré) ; sinon renvoie faux et ne touche à rien : une rotation de jeton faite par un utilisateur pendant le job n'est jamais écrasée.
-- Réservées à `service_role` (le worker) ; la base ne voit jamais de texte clair ni de clé. Retour arrière : supabase/rollbacks/20261226100000_s11_secrets_reencrypt.sql

create function private.secrets_reencrypt_due(p_current_version integer, p_limit integer default 100)
returns table (id uuid, purpose text, organization_id uuid, ciphertext text, nonce text, key_version integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_current_version is null or p_current_version not between 1 and 1000 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  return query
    select s.id, s.purpose, s.organization_id, s.ciphertext, s.nonce, s.key_version
      from private.secrets s
     where s.key_version <> p_current_version
        or (s.fingerprint is null and s.purpose in ('integration', 'integration_webhook'))
     order by s.created_at, s.id
     limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;

create function private.secret_reencrypted(
  p_id uuid, p_old_key_version integer, p_old_ciphertext text, p_ciphertext text, p_nonce text, p_key_version integer, p_fingerprint text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_id is null or p_old_key_version is null or p_old_ciphertext is null or p_ciphertext is null or p_nonce is null
     or p_key_version is null or p_key_version not between 1 and 1000 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  update private.secrets s
     set ciphertext = p_ciphertext, nonce = p_nonce, key_version = p_key_version, fingerprint = p_fingerprint, rotated_at = pg_catalog.now()
   where s.id = p_id and s.key_version = p_old_key_version and s.ciphertext = p_old_ciphertext;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

revoke all on function private.secrets_reencrypt_due(integer, integer) from public, anon, authenticated, service_role;
revoke all on function private.secret_reencrypted(uuid, integer, text, text, text, integer, text) from public, anon, authenticated, service_role;
grant execute on function private.secrets_reencrypt_due(integer, integer) to service_role;
grant execute on function private.secret_reencrypted(uuid, integer, text, text, text, integer, text) to service_role;

create function public.secrets_reencrypt_due(p_current_version integer, p_limit integer default 100)
returns table (id uuid, purpose text, organization_id uuid, ciphertext text, nonce text, key_version integer)
language sql stable security invoker set search_path = ''
as $$ select * from private.secrets_reencrypt_due(p_current_version, p_limit); $$;
create function public.secret_reencrypted(
  p_id uuid, p_old_key_version integer, p_old_ciphertext text, p_ciphertext text, p_nonce text, p_key_version integer, p_fingerprint text default null
)
returns boolean language sql security invoker set search_path = ''
as $$ select private.secret_reencrypted(p_id, p_old_key_version, p_old_ciphertext, p_ciphertext, p_nonce, p_key_version, p_fingerprint); $$;
revoke all on function public.secrets_reencrypt_due(integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.secret_reencrypted(uuid, integer, text, text, text, integer, text) from public, anon, authenticated, service_role;
grant execute on function public.secrets_reencrypt_due(integer, integer) to service_role;
grant execute on function public.secret_reencrypted(uuid, integer, text, text, text, integer, text) to service_role;
