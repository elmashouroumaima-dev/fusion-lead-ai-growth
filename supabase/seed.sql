-- Seed de DÉVELOPPEMENT LOCAL uniquement (supabase db reset). Jamais appliqué à staging/production.
-- Fixture imposée par docs/testing/strategy.md : deux entreprises, un utilisateur commun à deux
-- rôles différents, et au moins un Analyst et un Marketing Manager.
--
--   Alpha : shared = company_owner · alpha-admin = company_admin · alpha-marketing =
--           marketing_manager · alpha-sales = sales_agent · alpha-analyst = analyst
--   Beta  : beta-owner = company_owner · shared = sales_agent · beta-analyst = analyst
--   Projets (J16) : 2 par entreprise (Alpha : site vitrine, application Salla ; Beta : boutique, thème Salla).
--
-- Tous les comptes de seed partagent le mot de passe de développement défini ci-dessous
-- (valeur de test, sans lien avec un vrai compte). Domaine réservé « .test » (RFC 2606).

do $seed$
declare
  dev_password constant text := 'FusionLeap-dev-2026!';
  org_alpha constant uuid := 'a0000000-0000-4000-8000-0000000000a1';
  org_beta constant uuid := 'b0000000-0000-4000-8000-0000000000b1';
  u record;
begin
  -- Entreprises
  insert into public.organizations (id, name, slug, timezone, locale) values
    (org_alpha, 'Alpha', 'alpha', 'Africa/Casablanca', 'en'),
    (org_beta, 'Beta', 'beta', 'Asia/Riyadh', 'ar');

  -- Plan growth (15 utilisateurs) : les organisations de démonstration comptent 5 et 3 membres actifs (limite du plan
  -- trial : 3 depuis J14). Le statut reste « trial ».
  insert into public.subscriptions (organization_id, plan_id, status)
  select o, (select id from public.plans where code = 'growth'), 'trial'
  from unnest(array[org_alpha, org_beta]) as o;

  -- Utilisateurs (auth.users + identité e-mail pour pouvoir se connecter en local)
  for u in
    select * from (values
      ('00000000-0000-4000-8000-000000000001'::uuid, 'shared@seed.test'),
      ('00000000-0000-4000-8000-000000000002'::uuid, 'alpha-admin@seed.test'),
      ('00000000-0000-4000-8000-000000000003'::uuid, 'alpha-marketing@seed.test'),
      ('00000000-0000-4000-8000-000000000004'::uuid, 'alpha-sales@seed.test'),
      ('00000000-0000-4000-8000-000000000005'::uuid, 'alpha-analyst@seed.test'),
      ('00000000-0000-4000-8000-000000000006'::uuid, 'beta-owner@seed.test'),
      ('00000000-0000-4000-8000-000000000007'::uuid, 'beta-analyst@seed.test')
    ) as t (id, email)
  loop
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
      '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email,
      extensions.crypt(dev_password, extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
      '', '', '', ''
    );

    insert into auth.identities (
      id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), u.id::text, u.id,
      jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
      'email', now(), now(), now()
    );
  end loop;

  -- Adhésions (la source des rôles : jamais user_metadata)
  insert into public.organization_members (organization_id, user_id, role, status, invited_by) values
    (org_alpha, '00000000-0000-4000-8000-000000000001', 'company_owner', 'active', null),
    (org_alpha, '00000000-0000-4000-8000-000000000002', 'company_admin', 'active', '00000000-0000-4000-8000-000000000001'),
    (org_alpha, '00000000-0000-4000-8000-000000000003', 'marketing_manager', 'active', '00000000-0000-4000-8000-000000000001'),
    (org_alpha, '00000000-0000-4000-8000-000000000004', 'sales_agent', 'active', '00000000-0000-4000-8000-000000000001'),
    (org_alpha, '00000000-0000-4000-8000-000000000005', 'analyst', 'active', '00000000-0000-4000-8000-000000000001'),
    (org_beta, '00000000-0000-4000-8000-000000000006', 'company_owner', 'active', null),
    (org_beta, '00000000-0000-4000-8000-000000000001', 'sales_agent', 'active', '00000000-0000-4000-8000-000000000006'),
    (org_beta, '00000000-0000-4000-8000-000000000007', 'analyst', 'active', '00000000-0000-4000-8000-000000000006');

  -- Projets et produits (J16) : deux projets par entreprise, un produit sur le premier (scénario T1, docs/testing/strategy.md).
  insert into public.projects (id, organization_id, type, name, owner_id, settings) values
    ('a1000000-0000-4000-8000-000000000001', org_alpha, 'website_sales', 'Site vitrine Alpha', '00000000-0000-4000-8000-000000000001',
     '{"offers": ["Pack vitrine"], "target_market": "PME marocaines"}'),
    ('a1000000-0000-4000-8000-000000000002', org_alpha, 'salla_app', 'Application Salla Alpha', '00000000-0000-4000-8000-000000000002',
     '{"app_name": "Relance panier"}'),
    ('b1000000-0000-4000-8000-000000000001', org_beta, 'website_sales', 'Boutique en ligne Beta', '00000000-0000-4000-8000-000000000006',
     '{"offers": ["Pack boutique"]}'),
    ('b1000000-0000-4000-8000-000000000002', org_beta, 'salla_theme', 'Thème Salla Beta', '00000000-0000-4000-8000-000000000006',
     '{"sectors": ["mode"]}');
  insert into public.products (id, organization_id, project_id, kind, offer, price_hint) values
    ('a2000000-0000-4000-8000-000000000001', org_alpha, 'a1000000-0000-4000-8000-000000000001', 'site vitrine', 'Site vitrine en 5 jours', 'à partir de 2 000 MAD'),
    ('b2000000-0000-4000-8000-000000000001', org_beta, 'b1000000-0000-4000-8000-000000000001', 'boutique', 'Boutique en ligne clé en main', 'à partir de 6 000 MAD');
end
$seed$;

-- Administrateur de la plateforme (local uniquement) : accès à l'écran d'administration (J14, ADR 005 §10).
-- En production, les administrateurs sont ajoutés par SQL (opérations), jamais par l'application.
insert into private.platform_admins (user_id) values ('00000000-0000-4000-8000-000000000001') on conflict do nothing;

