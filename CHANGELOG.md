# Changelog

Format : Keep a Changelog. Une entrée par jour de travail.

## [Non publié]
### Interface (Tailwind v4 + shadcn/ui)
- Ajout : design system inspiré du tableau de bord ONMD (jetons clair/sombre, Poppins et Cairo en WOFF2, composants shadcn/ui, `next-themes`, `sonner`).
- Modifié : coquille d'application (barre latérale repliable, en-tête, sélecteur d'organisation, langue, thème, profil) et habillage de toutes les pages (connexion, inscription, réinitialisation, onboarding, sélecteur, tableau de bord, membres, invitation).
- Sécurité : en-têtes `X-Frame-Options`, `frame-ancestors 'none'`, `nosniff` sur toutes les routes.
- Supprimé : CSS maison et modules CSS devenus inutiles.
### J11 — Couche service
- Ajout : `withRoute` / `withAction` (pipeline fixe, erreurs `{ code, message, request_id }`), `Idempotency-Key` (tables, fonctions, rejeu 24 h, quota), limitation de débit par seaux de jetons (429 / 503), module `service_role` confiné.
- Ajout : migration `20261112100000_service_layer.sql`, fonctions de purge, runbook `purge-service-tables`.
- Modifié : `/api/orgs` et les actions membres/organisations passent par la couche service ; `lib/api/` supprimé.
- Sécurité : règles ESLint renforcées (`noInlineConfig` pour `apps/web`, imports non littéraux interdits).
### Français et locale par défaut
- Ajout : locale `fr` (par défaut), messages `fr.json`, sélecteur de langue à trois choix, e-mails d'authentification en trois langues.
- Ajout : migration `20261111100000_locale_fr.sql` (`organizations.locale` accepte `fr`, défaut `fr` ; retour arrière avec perte documenté).
- Modifié : `LOCALES` / `DEFAULT_LOCALE` centralisés dans `packages/domain`.
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
