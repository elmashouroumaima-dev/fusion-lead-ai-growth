-- Checkpoint C3 (J41) : balayage de la base à la recherche de secrets et de données de contact là où il ne doit y en avoir aucun.
-- Lecture seule. À lancer APRÈS le test réel (et après la suite de tests) :
--   docker exec -i supabase_db_fusion-leap psql -U postgres -A -t -F ' | ' < docs/testing/fixtures/c3-leak-scan.sql
-- Résultat attendu : tous les compteurs « fuites » à 0. `messages.body` contient légitimement le texte des messages : il n'est pas balayé.
select 'audit_logs : lignes', count(*)::text from public.audit_logs
union all select 'audit_logs : actions distinctes', count(distinct action)::text from public.audit_logs
union all select 'FUITES audit_logs : adresses e-mail', count(*)::text from public.audit_logs
  where (coalesce(before::text, '') || coalesce(after::text, '')) ~ '[A-Za-z0-9._-]+@[A-Za-z0-9.-]+[.][a-z]{2,}'
union all select 'FUITES audit_logs : numéros de téléphone (identifiants UUID retirés)', count(*)::text from public.audit_logs
  where regexp_replace(coalesce(before::text, '') || coalesce(after::text, ''), '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '', 'g') ~ '[+]?[0-9][0-9 ]{9,}'
union all select 'FUITES audit_logs : jetons, clés, mots de passe', count(*)::text from public.audit_logs
  where (coalesce(before::text, '') || coalesce(after::text, '')) ~* '(flk_[0-9a-f]{16}|EAA[A-Za-z0-9]{10}|bearer |password|secret.:|api[_-]?key.:|token.:)'
union all select 'FUITES audit_logs : champs de contenu (body, text, content, message, subject)', count(*)::text from public.audit_logs
  where (coalesce(before::text, '') || coalesce(after::text, '')) ~* '"(body|text_body|text|content|message|subject)"'
union all select 'jobs.last_error : valeurs distinctes (codes courts attendus)', coalesce(string_agg(distinct left(last_error, 40), ' ; '), '-') from public.jobs where last_error is not null
union all select 'FUITES jobs.payload : e-mail, téléphone ou texte', count(*)::text from public.jobs where payload::text ~* '(email|phone|body|text|@)'
union all select 'FUITES idempotency_keys : clé de formulaire en clair', count(*)::text from public.idempotency_keys where response::text ~ 'flk_[0-9a-f]{20}'
union all select 'private.secrets : lignes', count(*)::text from private.secrets
union all select 'FUITES private.secrets : jeton lisible (non chiffré)', count(*)::text from private.secrets where ciphertext ~ '(EAA[A-Za-z0-9]{10}|[Bb]earer )'
union all select 'webhook_events : lignes (contenu reçu conservé, sans purge : écart n°7)', count(*)::text from public.webhook_events;
