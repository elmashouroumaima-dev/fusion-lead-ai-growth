-- Paramètres SMTP et secrets chiffrés : droits, validation, mot de passe jamais renvoyé, remplacement et suppression
-- du secret, lecture serveur (service_role) du chiffré seulement. Tout est annulé en fin de test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(65);

-- U1 administrateur de la plateforme · U2 owner d'organisation (pas administrateur) · U3 sans adhésion
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('7a000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u1@sm.test', now()),
  ('7a000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u2@sm.test', now()),
  ('7a000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u3@sm.test', now());
insert into public.organizations (id, name, slug) values ('7b000000-0000-4000-8000-00000000000a', 'SM Alpha', 'sm-alpha-test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('7b000000-0000-4000-8000-00000000000a', '7a000000-0000-4000-8000-000000000002', 'company_owner', 'active');
insert into private.platform_admins (user_id) values ('7a000000-0000-4000-8000-000000000001');
delete from public.platform_config where key = 'smtp.settings';
delete from private.secrets;

create function pg_temp.as_user(p_uid text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $f$;
grant execute on function pg_temp.as_user(text) to public;

create function pg_temp.cfg(p_host text default 'sandbox.smtp.mailtrap.io', p_port integer default 2525) returns jsonb
language sql immutable as $f$
  select jsonb_build_object('host', p_host, 'port', p_port, 'security', 'starttls', 'username', 'u-test', 'from_email', 'no-reply@example.test', 'from_name', 'Fusion Leap')
$f$;
grant execute on function pg_temp.cfg(text, integer) to public;

-- 1. Structure et droits
select has_table('private', 'secrets', 'private.secrets existe');
select ok(not has_table_privilege('authenticated', 'private.secrets', 'select,insert,update,delete'), 'authenticated : aucun droit sur private.secrets');
select ok(not has_table_privilege('service_role', 'private.secrets', 'select,insert,update,delete'), 'service_role : aucun droit direct sur private.secrets');
select ok(not has_table_privilege('anon', 'private.secrets', 'select,insert,update,delete'), 'anon : aucun droit sur private.secrets');

-- 2. Écriture sans mot de passe (administrateur)
select pg_temp.as_user('7a000000-0000-4000-8000-000000000001');
select lives_ok($$select public.set_smtp_settings(pg_temp.cfg(), null, null, null, null)$$, 'admin : enregistre sans mot de passe');
select is((public.get_smtp_settings()) ->> 'host', 'sandbox.smtp.mailtrap.io', 'admin : relit l''hôte');
select is((public.get_smtp_settings()) ->> 'has_password', 'false', 'has_password = false');
reset role;
select is((select count(*)::int from private.secrets), 0, 'aucun secret créé');

-- 3. Avec mot de passe chiffré (côté serveur)
select pg_temp.as_user('7a000000-0000-4000-8000-000000000001');
select lives_ok($$select public.set_smtp_settings(pg_temp.cfg(), '7c000000-0000-4000-8000-000000000001', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'AAAAAAAAAAAAAAAA', 1)$$, 'admin : enregistre avec mot de passe chiffré');
select is((public.get_smtp_settings()) ->> 'has_password', 'true', 'has_password = true');
select ok(not ((public.get_smtp_settings()) ? 'secret_id') and not ((public.get_smtp_settings()) ? 'ciphertext') and not ((public.get_smtp_settings()) ? 'password'), 'la lecture administrateur ne contient ni secret_id, ni chiffré, ni mot de passe');
reset role;
select is((select count(*)::int from private.secrets), 1, 'un secret chiffré enregistré');
select is((select value ->> 'secret_id' from public.platform_config where key = 'smtp.settings'), '7c000000-0000-4000-8000-000000000001', 'la configuration référence le secret (secret_ref)');
select ok(not ((select value::text from public.platform_config where key = 'smtp.settings') like '%QUJDREVG%'), 'le chiffré n''est jamais dans platform_config');

-- 4. Mise à jour sans mot de passe : le secret est conservé ; remplacement : l'ancien est supprimé
select pg_temp.as_user('7a000000-0000-4000-8000-000000000001');
select lives_ok($$select public.set_smtp_settings(pg_temp.cfg() || '{"from_name": "Autre nom"}', null, null, null, null)$$, 'mise à jour (même destination) sans toucher au mot de passe');
reset role;
select is((select id::text from private.secrets), '7c000000-0000-4000-8000-000000000001', 'le secret existant est conservé');
select pg_temp.as_user('7a000000-0000-4000-8000-000000000001');
select lives_ok($$select public.set_smtp_settings(pg_temp.cfg('smtp.example.test', 587), '7c000000-0000-4000-8000-000000000002', 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0', 'BBBBBBBBBBBBBBBB', 2)$$, 'remplacement du mot de passe');
reset role;
select is((select count(*)::int from private.secrets), 1, 'l''ancien secret est supprimé');
select is((select id::text from private.secrets), '7c000000-0000-4000-8000-000000000002', 'seul le nouveau secret subsiste');

-- 4 bis. Revue sécurité : le mot de passe enregistré ne se réutilise pas vers une autre destination
select pg_temp.as_user('7a000000-0000-4000-8000-000000000001');
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg('attacker.example.net'), null, null, null, null)$$, '22023', 'password_required', 'changer l''hôte sans nouveau mot de passe : refusé');
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg('smtp.example.test', 25), null, null, null, null)$$, '22023', 'password_required', 'changer le port sans nouveau mot de passe : refusé');
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg('smtp.example.test', 587) || '{"username": "autre"}', null, null, null, null)$$, '22023', 'password_required', 'changer l''utilisateur sans nouveau mot de passe : refusé');
select throws_ok($$select public.set_smtp_settings((pg_temp.cfg('smtp.example.test', 587)) - 'username', null, null, null, null)$$, '22023', 'password_required', 'retirer l''utilisateur sans nouveau mot de passe : refusé');
select lives_ok($$select public.set_smtp_settings(pg_temp.cfg('smtp.example.test', 587) || '{"from_email": "autre@example.test"}', null, null, null, null)$$, 'changer seulement l''expéditeur : autorisé (même destination)');
reset role;
select is((select value ->> 'host' from public.platform_config where key = 'smtp.settings'), 'smtp.example.test', 'les refus n''ont pas redirigé le mot de passe');

-- 4 ter. Validation renforcée (revue sécurité)
select pg_temp.as_user('7a000000-0000-4000-8000-000000000001');
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg() || '{"from_email": "a,b@example.test"}', null, null, null, null)$$, '22023', 'validation_failed', 'expéditeur avec virgule refusé');
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg() || '{"from_email": "x<a@example.test>"}', null, null, null, null)$$, '22023', 'validation_failed', 'expéditeur avec chevrons refusé');
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg() || jsonb_build_object('from_email', '"a"@example.test'), null, null, null, null)$$, '22023', 'validation_failed', 'expéditeur avec guillemets refusé');
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg() || jsonb_build_object('username', 'u' || chr(8238) || 'v'), null, null, null, null)$$, '22023', 'validation_failed', 'utilisateur avec bidi refusé');
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg() || jsonb_build_object('from_name', 'a' || chr(8232) || 'b'), null, null, null, null)$$, '22023', 'validation_failed', 'nom avec séparateur de ligne U+2028 refusé');
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg() || jsonb_build_object('from_name', 'a' || chr(65279) || 'b'), null, null, null, null)$$, '22023', 'validation_failed', 'nom avec BOM U+FEFF refusé');
reset role;

-- 5. Lecture serveur du chiffré (service_role seulement)
set local role service_role;
select is((public.get_smtp_delivery()) #>> '{secret,key_version}', '2', 'service_role : lit le secret chiffré (version de clé)');
select is((public.get_smtp_delivery()) ->> 'host', 'smtp.example.test', 'service_role : lit les paramètres');
select ok(not ((public.get_smtp_delivery()) ? 'secret_id'), 'secret_id non exposé');
select is(public.get_platform_config('smtp.settings'), null, 'get_platform_config ne donne jamais smtp.settings');
reset role;
select pg_temp.as_user('7a000000-0000-4000-8000-000000000001');
select throws_ok($$select public.get_smtp_delivery()$$, '42501', null, 'même l''administrateur : get_smtp_delivery refusé (serveur seulement)');
reset role;
set local role anon;
select throws_ok($$select public.get_smtp_delivery()$$, '42501', null, 'anon : get_smtp_delivery refusé');
reset role;

-- 6. Refus : owner d'organisation, sans adhésion, anon
select pg_temp.as_user('7a000000-0000-4000-8000-000000000002');
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg('evil.example.test'), null, null, null, null)$$, '42501', 'forbidden', 'owner d''organisation : écriture refusée');
select throws_ok($$select public.get_smtp_settings()$$, '42501', 'forbidden', 'owner d''organisation : lecture refusée');
select throws_ok($$select public.reset_smtp_settings()$$, '42501', 'forbidden', 'owner d''organisation : suppression refusée');
select throws_ok($$select public.set_platform_config('smtp.settings', pg_temp.cfg())$$, '22023', 'validation_failed', 'set_platform_config ne permet pas d''écrire smtp.settings');
select throws_ok($$insert into public.platform_config (key, value) values ('smtp.settings', '{}'::jsonb)$$, '42501', null, 'écriture directe refusée');
reset role;
select pg_temp.as_user('7a000000-0000-4000-8000-000000000003');
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg('evil.example.test'), null, null, null, null)$$, '42501', 'forbidden', 'sans adhésion : refusé');
reset role;
set local role anon;
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg(), null, null, null, null)$$, '42501', null, 'anon : refusé');
reset role;
select is((select value ->> 'host' from public.platform_config where key = 'smtp.settings'), 'smtp.example.test', 'aucune tentative refusée n''a modifié la configuration');

-- 7. Validation (administrateur)
select pg_temp.as_user('7a000000-0000-4000-8000-000000000001');
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg('hôte invalide!'), null, null, null, null)$$, '22023', 'validation_failed', 'hôte invalide refusé');
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg('-debut.example.test'), null, null, null, null)$$, '22023', 'validation_failed', 'hôte commençant par un tiret refusé');
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg('smtp.example.test', 0), null, null, null, null)$$, '22023', 'validation_failed', 'port 0 refusé');
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg('smtp.example.test', 70000), null, null, null, null)$$, '22023', 'validation_failed', 'port 70000 refusé');
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg() || '{"port": "25"}', null, null, null, null)$$, '22023', 'validation_failed', 'port textuel refusé');
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg() || '{"security": "ssl"}', null, null, null, null)$$, '22023', 'validation_failed', 'sécurité inconnue refusée');
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg() || '{"from_email": "pas-un-email"}', null, null, null, null)$$, '22023', 'validation_failed', 'expéditeur invalide refusé');
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg() || jsonb_build_object('username', E'u\nv'), null, null, null, null)$$, '22023', 'validation_failed', 'utilisateur avec contrôle refusé');
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg() || jsonb_build_object('from_name', 'nom ' || chr(8238)), null, null, null, null)$$, '22023', 'validation_failed', 'nom d''expéditeur avec bidi refusé');
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg() || '{"password": "secret"}', null, null, null, null)$$, '22023', 'validation_failed', 'un mot de passe en clair dans les paramètres est refusé');
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg() || '{"secret_id": "7c000000-0000-4000-8000-0000000000ff"}', null, null, null, null)$$, '22023', 'validation_failed', 'secret_id imposé par le client refusé');
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg(), null, 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'AAAAAAAAAAAAAAAA', 1)$$, '22023', 'validation_failed', 'chiffré sans identifiant : refusé');
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg('smtp.example.test', 587), '7c000000-0000-4000-8000-000000000003', null, null, null)$$, '22023', 'validation_failed', 'identifiant sans chiffré : refusé');
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg(), '7c000000-0000-4000-8000-000000000004', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'trop court', 1)$$, '23514', null, 'nonce mal formé refusé par la contrainte');
select throws_ok($$select public.set_smtp_settings(pg_temp.cfg(), '7c000000-0000-4000-8000-000000000005', '<script>alert(1)</script>', 'AAAAAAAAAAAAAAAA', 1)$$, '23514', null, 'chiffré non base64 refusé par la contrainte');
reset role;
select is((select count(*)::int from private.secrets), 1, 'les refus n''ont créé aucun secret');

-- 8. Suppression
select pg_temp.as_user('7a000000-0000-4000-8000-000000000001');
select lives_ok($$select public.reset_smtp_settings()$$, 'admin : supprime la configuration');
reset role;
select is((select count(*)::int from public.platform_config where key = 'smtp.settings'), 0, 'configuration supprimée');
select is((select count(*)::int from private.secrets), 0, 'secret supprimé avec elle');
select pg_temp.as_user('7a000000-0000-4000-8000-000000000001');
select is(public.get_smtp_settings(), null, 'lecture après suppression : null');
reset role;

select * from finish();
rollback;
