# Changelog

Format : Keep a Changelog. Une entrée par jour de travail.

## [Non publié]
### J10 — Membres, invitations et RBAC
- Ajout : `packages/permissions` (matrice ADR 014 complète, `can`, `canManageMember`, `assignableRoles`).
- Ajout : table `invitations` et fonctions `create_invitation`, `revoke_invitation`, `accept_invitation`, `transfer_ownership` (jeton haché, expiration 7 jours, erreur générique unique).
- Ajout : page Membres et page d'acceptation d'invitation (AR/EN, `Referrer-Policy: no-referrer`).
- Sécurité : re-vérification de l'inviteur à l'acceptation, ordre de verrous stable pour le transfert de propriété, e-mails ASCII uniquement.
### J9 — Organisations et contexte actif
- Ajout : `public.create_organization()` (enveloppe invoker) et `private.create_organization()` (security definer) : organisation + propriétaire + abonnement trial en une transaction, idempotente.
- Ajout : `POST /api/orgs`, `getTenantContext()`, cookie `fl_active_org`, pages onboarding et sélecteur d'organisation (AR/EN).
- Modifié : `organizations` gagne `created_by` et `creation_key`.
- Sécurité : validation commune SQL/zod des noms (caractères invisibles/bidi refusés) et des fuseaux horaires.
### J8 — Auth SSR bilingue (AR/EN)
- Ajout : clients Supabase SSR, `proxy.ts` (next-intl + session + routes protégées, échec fermé), actions d'authentification, route `/auth/confirm`, pages login/signup/forgot/reset/dashboard en arabe (RTL) et anglais.
- Ajout : schémas zod d'authentification (`@fusion-leap/domain`), variable `SITE_URL`, templates d'e-mail, skills projet.
- Sécurité : correction d'un contournement du proxy par locale encodée (`/%61r/...`).
- Modifié : `supabase/config.toml` (redirections, mot de passe ≥ 10, confirmation d'e-mail locale).
### J7 — RLS du noyau et harnais de tests
### J6 — Schéma du noyau tenant
### J5 — Environnements et garde-fou de fuite
### J4 — Monorepo et CI
