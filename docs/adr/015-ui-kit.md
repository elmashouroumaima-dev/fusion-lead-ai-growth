# ADR 015 — Kit d'interface : Tailwind CSS v4 + shadcn/ui

- **Statut :** Proposed — **bibliothèques hors stack imposée : accord explicite requis** (l'accord de principe a été donné le 2026-11-07 : « OK, merge #6 puis UI »)
- **Date :** 2026-11-07
- **Section de spec :** §6 (UI Next.js), ADR 011 (RTL/i18n), ADR 001 (versions)

## Contexte
L'interface livrée jusqu'au J11 est fonctionnelle mais minimale (CSS maison). La responsable du projet veut le rendu du tableau de bord « ONMD » (projet `frontend` : shadcn/ui « new-york », Tailwind v4, barre latérale repliable, thèmes clair/sombre, police Poppins).

## Décision
- **Tailwind CSS v4** (`tailwindcss`, `@tailwindcss/postcss`) et **shadcn/ui** : composants copiés dans `apps/web/components/ui/` (code du projet, pas une dépendance opaque) au-dessus de **Radix UI**, `class-variance-authority`, `clsx`, `tailwind-merge`, `tw-animate-css`, **`lucide-react`** (icônes), **`next-themes`** (clair / sombre / système), **`sonner`** (notifications), **`cmdk`** (recherche globale, plus tard). Versions épinglées exactement.
- **Jetons de design** (couleurs, rayons, ombres) repris du projet ONMD : palette neutre (zinc), primaire vert `#006a4e`, secondaire `#ae2b2f`, rayon `0.5rem`, variables CSS pour les modes clair et sombre.
- **Polices** : Poppins (latin) et une police arabe (Cairo), servies localement (`next/font/local`) pour ne dépendre d'aucun réseau au build.
- **RTL** : uniquement des classes logiques (`ms-`, `me-`, `ps-`, `pe-`, `start-`, `end-`, `text-start`, `text-end`, `rounded-s/e`, `border-s/e`) ; la barre latérale passe côté droit en arabe ; test automatique contre les classes physiques.
- **Portée** : habillage de l'existant (connexion, inscription, réinitialisation, onboarding, sélecteur d'organisation, tableau de bord, membres, invitation) et d'une coquille d'application (barre latérale, en-tête, sélecteur d'organisation, langue, thème, profil). Aucune page métier du projet ONMD n'est reprise ; aucune donnée fictive.

## Alternatives
CSS maison (statu quo) : plus de code à maintenir et pas de composants accessibles prêts. Autre kit (MUI, Mantine) : style différent de la cible, runtime plus lourd.

## Conséquences
Dépendances supplémentaires (supply-chain) : épinglées, sans script d'installation (vérifié), revue de licences (MIT/ISC). Les modules CSS existants sont supprimés au fur et à mesure. Les tests existants restent valables (comportement inchangé).

## Mise en œuvre (2026-11-07)
- **Composants** (`apps/web/components/ui/`) : button, card, input, label, badge, separator, alert, avatar, tooltip, table, dialog, sheet, dropdown-menu, select, breadcrumb, sidebar, sonner. Les composants non utilisés (tabs, switch, checkbox, collapsible, scroll-area, command, textarea, skeleton) et leurs paquets (`cmdk`, `@radix-ui/react-tabs/switch/checkbox/collapsible/scroll-area`) ont été retirés ; `@radix-ui/react-direction` ajouté (sens RTL des primitives). À rajouter quand un écran en a besoin (la recherche globale `cmdk` reste prévue).
- **Écarts aux jetons ONMD** (accessibilité WCAG AA) : bordure des champs `--input` plus foncée (`#8a8a93` clair, `#71717a` sombre) ; nouveau jeton `--destructive-text` (`#b91c1c` clair, `#fca5a5` sombre) pour les textes d'erreur ; `--muted-foreground`, `--destructive` et l'anneau de focus ajustés. Un test calcule les contrastes des deux thèmes.
- **Polices** : Poppins (4 graisses) et Cairo en WOFF2 sous-ensemblés (`app/fonts/`, licences OFL conservées). Cairo n'est chargée que sur les pages arabes (`preload: false` : un préchargement apparaissait sur fr/en car le module est dans le graphe du layout) ; la règle `@font-face` est présente dans le CSS mais la police n'est pas téléchargée ailleurs.
- **En-têtes de sécurité globaux** : `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'` (seule directive : une CSP complète est hors périmètre car `next-themes` injecte un script inline), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` (les pages d'invitation, de connexion et d'inscription gardent `no-referrer`).
- **Garde-fous automatiques** (`apps/web/ui-audit/`, tests permanents) : classes Tailwind physiques interdites (RTL), contrastes AA, pas de chaîne en dur, parité fr/ar/en, pas de CSS mort, polices locales.
- **Statut** : reste « Proposed » (validation de la responsable technique).
