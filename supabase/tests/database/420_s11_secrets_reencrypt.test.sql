-- S-11 : fonctions SQL du rechiffrement des secrets après une rotation de la clé maître. `secrets_reencrypt_due` liste les secrets d'une AUTRE version de clé (et les jetons / secrets de
-- webhook sans empreinte) ; `secret_reencrypted` n'écrit que si la ligne n'a pas changé depuis la lecture (aucun écrasement d'une rotation concurrente). Réservées à service_role. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(15);

insert into public.organizations (id, name, slug) values ('ebc00000-0000-4000-8000-0000000000b1', 'S11 Alpha', 's11-alpha-test');
-- A : ancienne version (1), SMTP ; B : version courante (2) mais jeton sans empreinte (d'avant S-12) ; C : à jour
insert into private.secrets (id, purpose, organization_id, ciphertext, nonce, key_version, fingerprint) values
  ('edc00000-0000-4000-8000-0000000000a1', 'smtp', null, 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 1, null),
  ('edc00000-0000-4000-8000-0000000000b1', 'integration', 'ebc00000-0000-4000-8000-0000000000b1', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 2, null),
  ('edc00000-0000-4000-8000-0000000000c1', 'integration', 'ebc00000-0000-4000-8000-0000000000b1', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 2, repeat('a', 64));

select is((select count(*)::integer from private.secrets_reencrypt_due(2, 100) where id in ('edc00000-0000-4000-8000-0000000000a1', 'edc00000-0000-4000-8000-0000000000b1', 'edc00000-0000-4000-8000-0000000000c1')), 2,
  'S-11 : deux secrets à rechiffrer (autre version de clé, jeton sans empreinte)');
select is((select array_agg(id::text order by id::text) from private.secrets_reencrypt_due(2, 100) where id in ('edc00000-0000-4000-8000-0000000000a1', 'edc00000-0000-4000-8000-0000000000b1', 'edc00000-0000-4000-8000-0000000000c1')),
  array['edc00000-0000-4000-8000-0000000000a1', 'edc00000-0000-4000-8000-0000000000b1'], 'S-11 : A (ancienne version) et B (sans empreinte), jamais C (à jour)');

-- écriture A : ancienne version et ancien chiffré identiques à ceux lus
select is(private.secret_reencrypted('edc00000-0000-4000-8000-0000000000a1', 1, 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'WllYV1ZVVFNSUVBPTk1MS0pJSEdGRURDQkE=', 'TUxLSkhHRkRTQVFX', 2), true,
  'S-11 : écriture acceptée quand la ligne n''a pas changé depuis la lecture');
select ok((select key_version = 2 and ciphertext = 'WllYV1ZVVFNSUVBPTk1MS0pJSEdGRURDQkE=' and nonce = 'TUxLSkhHRkRTQVFX' and rotated_at is not null from private.secrets where id = 'edc00000-0000-4000-8000-0000000000a1'),
  'S-11 : version, chiffré et nonce remplacés, date de rotation renseignée');
select is(private.secret_reencrypted('edc00000-0000-4000-8000-0000000000a1', 1, 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'QUJDREVGR0hJSktM', 2), false,
  'S-11 : rejeu avec l''ancienne version : refusé (rien n''est écrasé)');
select is(private.secret_reencrypted('edc00000-0000-4000-8000-0000000000b1', 2, 'AUTRECHIFFREAUTRECHIFFRE', 'WllYV1ZVVFNSUVBPTk1MS0pJSEdGRURDQkE=', 'TUxLSkhHRkRTQVFX', 2), false,
  'S-11 : ancien chiffré différent de celui de la ligne (rotation concurrente) : refusé');
select is((select count(*)::integer from private.secrets_reencrypt_due(2, 100) where id in ('edc00000-0000-4000-8000-0000000000a1', 'edc00000-0000-4000-8000-0000000000b1', 'edc00000-0000-4000-8000-0000000000c1')), 1,
  'S-11 : il ne reste que B à rechiffrer');

-- B : même version, empreinte recalculée
select is(private.secret_reencrypted('edc00000-0000-4000-8000-0000000000b1', 2, 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'WllYV1ZVVFNSUVBPTk1MS0pJSEdGRURDQkE=', 'TUxLSkhHRkRTQVFX', 2, repeat('b', 64)), true,
  'S-11 : B réécrit avec son empreinte');
select is((select fingerprint from private.secrets where id = 'edc00000-0000-4000-8000-0000000000b1'), repeat('b', 64), 'S-11 : l''empreinte est enregistrée');

-- droits : service_role seulement
select ok(not has_function_privilege('authenticated', 'public.secrets_reencrypt_due(integer, integer)', 'execute') and not has_function_privilege('authenticated', 'public.secret_reencrypted(uuid, integer, text, text, text, integer, text)', 'execute')
  and not has_function_privilege('authenticated', 'private.secrets_reencrypt_due(integer, integer)', 'execute'), 'S-11 : authenticated n''exécute aucune de ces fonctions');
select ok(not has_function_privilege('anon', 'public.secrets_reencrypt_due(integer, integer)', 'execute') and not has_function_privilege('anon', 'public.secret_reencrypted(uuid, integer, text, text, text, integer, text)', 'execute'),
  'S-11 : anon non plus');
select ok(has_function_privilege('service_role', 'public.secrets_reencrypt_due(integer, integer)', 'execute') and has_function_privilege('service_role', 'public.secret_reencrypted(uuid, integer, text, text, text, integer, text)', 'execute')
  and has_function_privilege('service_role', 'private.secrets_reencrypt_due(integer, integer)', 'execute') and has_function_privilege('service_role', 'private.secret_reencrypted(uuid, integer, text, text, text, integer, text)', 'execute'),
  'S-11 : service_role (le worker) les exécute');

-- entrées invalides
select throws_ok($$select * from private.secrets_reencrypt_due(0, 10)$$, '22023', 'validation_failed', 'S-11 : version courante hors plage refusée');
select throws_ok($$select private.secret_reencrypted('edc00000-0000-4000-8000-0000000000b1', 2, 'x', 'WllYV1ZVVFNSUVBPTk1MS0pJSEdGRURDQkE=', 'TUxLSkhHRkRTQVFX', 0)$$, '22023', 'validation_failed', 'S-11 : version d''écriture hors plage refusée');
select throws_ok($$select private.secret_reencrypted('edc00000-0000-4000-8000-0000000000b1', 2, 'WllYV1ZVVFNSUVBPTk1MS0pJSEdGRURDQkE=', 'WllYV1ZVVFNSUVBPTk1MS0pJSEdGRURDQkE=', 'TUxLSkhHRkRTQVFX', 2, 'pas-une-empreinte')$$, '23514', null, 'S-11 : empreinte mal formée refusée');

select * from finish();
rollback;
