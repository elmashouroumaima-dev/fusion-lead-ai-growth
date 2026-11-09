# Démarrer Fusion Leap AI Growth (guide d'installation)

Ce guide explique, étape par étape, comment récupérer le code, installer ce qu'il faut et **lancer le projet sur votre machine** (application web, base de données locale, worker, tests). Compter 20 à 40 minutes la première fois (téléchargement des images Docker).

> Tout tourne **en local** : aucune clé de production, aucun compte cloud n'est nécessaire. Les seuls identifiants à créer vous-même sont facultatifs (e-mails de test, voir §9).

## Sommaire
1. [Ce qu'il faut installer](#1-ce-quil-faut-installer)
2. [Récupérer le code](#2-récupérer-le-code)
3. [Installer les dépendances](#3-installer-les-dépendances)
4. [Démarrer la base de données locale (Supabase)](#4-démarrer-la-base-de-données-locale-supabase)
5. [Configurer les variables d'environnement](#5-configurer-les-variables-denvironnement)
6. [Lancer l'application](#6-lancer-lapplication)
7. [Comptes de test](#7-comptes-de-test)
8. [Lancer le worker (jobs)](#8-lancer-le-worker-jobs)
9. [E-mails de test (facultatif)](#9-e-mails-de-test-facultatif)
10. [Lancer les tests](#10-lancer-les-tests)
11. [Commandes utiles](#11-commandes-utiles)
12. [Dépannage](#12-dépannage)
13. [Règles à respecter](#13-règles-à-respecter)
14. [Pour aller plus loin](#14-pour-aller-plus-loin)
15. [Ce que contient le projet (J0 à J25)](#15-ce-que-contient-le-projet-j0-à-j25)
16. [Parcours de démonstration](#16-parcours-de-démonstration)
17. [Checklist « nouveau PC »](#17-checklist--nouveau-pc-)

---

## 1. Ce qu'il faut installer

| Outil | Version | Pourquoi | Vérifier |
|---|---|---|---|
| **Git** | récent | récupérer le code | `git --version` |
| **Node.js** | **≥ 22.12** (recommandé : **24.13.1**, voir `.nvmrc`) | exécuter l'application, les tests, la CLI Supabase | `node -v` |
| **pnpm** | **12.18.0** (champ `packageManager`) | gestionnaire de paquets du monorepo | `pnpm -v` |
| **Docker Desktop** | récent, **démarré** | base de données et services Supabase en local | `docker ps` |
| Google Chrome | récent | *facultatif* : générer le PDF du rapport d'avancement | — |
| GitHub CLI (`gh`) | récent | *facultatif* : compter les PR dans le rapport | `gh --version` |

La CLI Supabase **n'est pas à installer** : elle est dans le projet (`pnpm exec supabase …`).

### Installer Node.js 24.13.1
- **Windows** : installer [nvm-windows](https://github.com/coreybutler/nvm-windows), puis `nvm install 24.13.1` et `nvm use 24.13.1`.
- **macOS / Linux** : installer [nvm](https://github.com/nvm-sh/nvm), puis `nvm install 24.13.1` et `nvm use 24.13.1` (ou `nvm use` à la racine du projet, qui lit `.nvmrc`).

> **Node 20 ne fonctionne pas** (Vitest 5 exige Node 22.12+). Après `nvm use`, vérifier `node -v` **dans le même terminal** que celui où vous lancez les commandes.

### Installer pnpm 12.18.0
```bash
corepack enable
corepack prepare pnpm@12.18.0 --activate
pnpm -v        # doit afficher 12.18.0
```

### Docker Desktop
Installer [Docker Desktop](https://www.docker.com/products/docker-desktop/), le **lancer** et attendre qu'il soit « running ». Prévoir environ **6 Go de RAM** disponibles pour Docker et **10 Go d'espace disque** (images Supabase).

---

## 2. Récupérer le code

```bash
git clone <URL-du-dépôt-git>        # l'adresse vous est donnée par la personne qui vous envoie le code
cd fusion-lead-ai-growth
```

Les journées de travail sont livrées par **pull requests empilées** : tant qu'elles ne sont pas toutes fusionnées dans `main`, la dernière version du projet se trouve sur la **branche de la PR la plus récente**. Pour travailler sur la dernière version :

```bash
git fetch --all
git checkout day-25-crm-adapter      # dernière journée livrée (J25) ; ou la branche indiquée par la personne qui vous envoie le code
```

Ordre des branches (chaque PR s'appuie sur la précédente) : `day-17-projects-ui` → `day-17-storage` → `day-18-contacts` → `day-19-leads` → `day-20-activities` → `day-21-capture` → `day-22-assignment` → `day-23-import` → `day-24-crm-ui` → `day-25-crm-adapter`.

---

## 3. Installer les dépendances

À la racine du projet :

```bash
nvm use                # lit .nvmrc (Node 24.13.1)
corepack enable
pnpm install
```

`pnpm install` installe tout le monorepo (`apps/web`, `apps/worker`, `packages/*`). Si pnpm signale des scripts de build ignorés, c'est normal : la liste autorisée est déjà dans `pnpm-workspace.yaml`.

---

## 4. Démarrer la base de données locale (Supabase)

Docker doit être démarré. À la racine :

```bash
pnpm db:start
```

La **première fois**, cela télécharge une dizaine d'images Docker (plusieurs minutes). Quand la commande se termine, la pile locale est prête :

| Service | Adresse |
|---|---|
| API Supabase | http://127.0.0.1:54321 |
| Base Postgres | `127.0.0.1:54322` |
| Studio (interface de la base) | http://127.0.0.1:54323 |
| Boîte e-mail locale (Mailpit) | http://127.0.0.1:54324 |

Appliquer le schéma et les données de démonstration (comptes de test, deux organisations) :

```bash
pnpm db:reset
```

> `pnpm db:reset` **efface et recrée** la base locale à partir des migrations (`supabase/migrations`) et de `supabase/seed.sql`. C'est sans danger en local ; à refaire quand on change de branche.

---

## 5. Configurer les variables d'environnement

Les fichiers `.env*` ne sont **jamais** dans git. Créer le fichier local :

```bash
cp .env.development.example .env.local          # Windows PowerShell : Copy-Item .env.development.example .env.local
```

Puis récupérer les deux clés de la base locale :

```bash
pnpm exec supabase status -o env
```

Recopier dans `.env.local` :

| Dans la sortie de `supabase status` | Variable à renseigner dans `.env.local` |
|---|---|
| `PUBLISHABLE_KEY` | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` |
| `SECRET_KEY` | `SUPABASE_SECRET_KEY` |

Pour enregistrer un mot de passe SMTP dans Paramétrage, générer aussi une clé de chiffrement locale et la coller dans `SECRETS_MASTER_KEY` :

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Les autres valeurs de `.env.local` (URL `http://127.0.0.1:54321`, `SITE_URL=http://127.0.0.1:3000`, `APP_ENV=development`, `AI_ALLOW_REAL_DATA=false`) sont déjà bonnes. Laisser `RESEND_API_KEY` vide.

> Ces clés sont des clés **locales de développement** (elles ne servent qu'à votre Supabase Docker). Ne les mettez jamais dans une variable `NEXT_PUBLIC_*` autre que la clé « publishable », et ne les commitez jamais.

Si l'application refuse de démarrer avec « Environnement invalide », une variable obligatoire manque : le message dit laquelle.

---

## 6. Lancer l'application

```bash
pnpm dev
```

Ouvrir **http://127.0.0.1:3000** (utiliser `127.0.0.1`, c'est l'adresse prévue pour le développement ; `localhost` fonctionne aussi). Pages utiles :

- Connexion : http://127.0.0.1:3000/fr/login (langues : `/fr`, `/ar`, `/en`)
- Tableau de bord, Membres, Paramétrage (couleurs et logo), Administration (voir §7).
- Ventes (J16 à J25) : **Projets**, **Leads** (recherche, filtres, export CSV), **Deals** (tableau par étape), **CRM** (état de la synchronisation, « Réessayer »). Choisir l'organisation **Alpha** avec `shared@seed.test`.
- Sans écran (API ou tests seulement) : import CSV, capture de leads par formulaire, assignation automatique, contacts et consentement.

Arrêter : `Ctrl+C`.

---

## 7. Comptes de test

Le seed crée deux organisations (**Alpha** et **Beta**) et ces comptes (tous confirmés, prêts à se connecter) :

| E-mail | Rôle |
|---|---|
| `shared@seed.test` | propriétaire d'Alpha, *sales agent* de Beta, **administrateur de la plateforme** |
| `alpha-admin@seed.test` | administrateur d'Alpha |
| `alpha-marketing@seed.test` | marketing manager d'Alpha |
| `alpha-sales@seed.test` | sales agent d'Alpha |
| `alpha-analyst@seed.test` | analyste d'Alpha |
| `beta-owner@seed.test` | propriétaire de Beta |
| `beta-analyst@seed.test` | analyste de Beta |

**Mot de passe de développement** : la constante `dev_password` au début de `supabase/seed.sql` (valeur de test, valable seulement en local).

À essayer :
- Se connecter avec `shared@seed.test`, choisir **Alpha** : on voit *Tableau de bord*, *Membres*, *Paramétrage* et *Administration* (réservée aux administrateurs de la plateforme).
- Se connecter avec `alpha-sales@seed.test` : pas de lien *Membres* ni *Paramétrage* (droits insuffisants).
- *Créer un compte* (`/fr/signup`) envoie un e-mail de confirmation : il faut la boîte de test du §9.

---

## 8. Lancer le worker (jobs)

Le worker traite la file de jobs (Postgres). Dans un **second terminal** (Node 24 actif), base démarrée et `.env.local` rempli :

```bash
pnpm worker:dev
```

Il affiche une ligne JSON par événement. Pour voir un job passer, en créer un de démonstration (SQL, local seulement) :

```bash
docker exec supabase_db_fusion-leap psql -U postgres -c "select private.enqueue_job('a0000000-0000-4000-8000-0000000000a1', 'noop', '{}'::jsonb, 'demo-' || gen_random_uuid())"
```

Le worker affiche `job_succeeded`. Détails : `docs/runbooks/jobs-worker.md`.

Il traite aussi les jobs métier : `lead.assign` (assignation automatique), `import_csv` (import de leads) et `crm_sync` (synchronisation CRM). Sans worker, ces jobs restent « En file ».

---

## 9. E-mails de test (facultatif)

> Deux réglages différents : **ce paragraphe** configure le SMTP de Supabase Auth (e-mails d'inscription). La carte **Paramètres SMTP** de l'application (menu *Paramétrage*, compte `shared@seed.test`) enregistre le SMTP de l'application : bouton « Utiliser Mailtrap », puis utilisateur et mot de passe de votre boîte, puis « Envoyer un e-mail de test » (voir `docs/runbooks/smtp-settings.md`).

Sans cette étape tout fonctionne **sauf l'inscription par e-mail** (les comptes du §7 suffisent pour tout essayer). Pour recevoir les e-mails de confirmation :

1. Créer un compte gratuit sur [Mailtrap](https://mailtrap.io) → *Email Testing* → *Inboxes* → *SMTP Settings*.
2. Copier `supabase/.env.local.example` vers `supabase/.env` et renseigner `MAILTRAP_SMTP_USER` et `MAILTRAP_SMTP_PASS`.
3. Redémarrer : `pnpm db:stop` puis `pnpm db:start`.

Tous les e-mails sont capturés dans la boîte Mailtrap, rien n'est envoyé à de vraies adresses. Détails : `docs/runbooks/local-email.md`.

---

## 10. Lancer les tests

Base démarrée (Docker) pour les tests de base de données :

```bash
pnpm lint            # ESLint (frontières de packages, pas de any)
pnpm typecheck       # TypeScript strict dans chaque package
pnpm test            # tests unitaires (domain, permissions, web, worker, adapters)
pnpm test:db         # tests SQL pgTAP (schéma, RLS, fonctions)
pnpm test:rls        # tests de sécurité via l'API réelle (isolation entre organisations)
pnpm build           # build de production de l'application
pnpm check:leaks --require-bundle   # aucun secret dans le bundle navigateur
```

Tests d'acceptation (HTTP réel : il faut `pnpm dev` dans un autre terminal, et la base démarrée et réinitialisée) :

```bash
pnpm test:e2e
```

Ordres de grandeur à J25 : domaine 608, web 2469, worker 76, adaptateurs 34, pgTAP 2397, RLS 436, acceptation 106. Les tests RLS qui touchent au Storage exigent le service `storage-api` de Supabase (il est actif par défaut avec `pnpm db:start`).

Tout doit être **vert**. Si `pnpm test:db` signale un test sur « aucun seau créé », c'est que des données d'usage traînent : `pnpm db:reset` puis relancer.

---

## 11. Commandes utiles

| Commande | Effet |
|---|---|
| `pnpm dev` | application web (http://127.0.0.1:3000) |
| `pnpm worker:dev` | worker de jobs |
| `pnpm db:start` / `pnpm db:stop` | démarrer / arrêter la pile Supabase locale |
| `pnpm db:reset` | recréer la base (migrations + seed) |
| `pnpm db:migrate` | appliquer les nouvelles migrations sans tout effacer |
| `pnpm test`, `pnpm test:db`, `pnpm test:rls`, `pnpm test:e2e` | tests (le dernier exige `pnpm dev`) |
| `pnpm format` | formater le code (Prettier) |
| `pnpm report:progress` | générer le rapport d'avancement (HTML + PDF) |
| `pnpm exec supabase status` | adresses et clés locales |

---

## 12. Dépannage

| Symptôme | Cause et solution |
|---|---|
| `pnpm : commande introuvable` | `corepack enable` puis rouvrir le terminal |
| Erreur de version de Node / Vitest | `node -v` doit afficher ≥ 22.12 (idéal 24.13.1) : `nvm use 24.13.1` **dans le terminal courant** |
| `Cannot connect to the Docker daemon` | lancer Docker Desktop et attendre qu'il soit prêt |
| `pnpm db:start` échoue (port déjà pris) | fermer ce qui utilise 54321–54324 / 3000, ou `pnpm db:stop` puis `pnpm db:start` |
| « Démarrage refusé. Environnement invalide » | une variable manque dans `.env.local` (le message la nomme) |
| Page blanche ou « Invalid Server Actions request » | ouvrir `http://127.0.0.1:3000` (ou `localhost:3000`), pas l'adresse réseau |
| Inscription : « Une erreur est survenue » | e-mails de test non configurés : voir §9 (ou utiliser les comptes du §7) |
| `Remote migration versions not found in local migrations directory` | vous avez changé de branche : `pnpm db:reset` |
| Un conteneur `supabase_vector` redémarre en boucle | sans conséquence en local, ignorer |
| La première `pnpm db:start` est très longue | normal : téléchargement des images Docker |

---

## 13. Règles à respecter

- **Aucun secret dans git** : les fichiers `.env*` (hors `*.example`) et `supabase/.env` sont ignorés ; ne jamais les commiter ni les envoyer par message.
- **Données de test uniquement** : jamais de données de clients réels (`AI_ALLOW_REAL_DATA=false`).
- Ne **jamais** modifier une migration déjà appliquée (`supabase/migrations`) : créer une nouvelle migration avec son retour arrière dans `supabase/rollbacks`.
- Avant de proposer un changement : `pnpm lint && pnpm typecheck && pnpm test` (et `pnpm test:db`, `pnpm test:rls` si la base change) doivent être verts.
- Conventions : TypeScript strict, validation zod sur toute entrée, commits *Conventional Commits* (`feat(scope): …`). Détails dans `CLAUDE.md`.

---

## 14. Pour aller plus loin

| Sujet | Fichier |
|---|---|
| Vue d'ensemble, arborescence, commandes | `README.md` |
| Spécification technique (en arabe) | `docs/spec/Fusion-Leap-AI-Growth-Technical-Spec.md` |
| Plan de développement (63 jours) | `docs/plan/development-plan.md` |
| API des modules de vente (projets, contacts, leads, capture, import, CRM) | `docs/api/` |
| Intégration CRM | `docs/integrations/crm.md` |
| Journal d'avancement et rapport PDF | `docs/progress/journal.md`, `docs/progress/report/` |
| Décisions d'architecture (ADR) | `docs/adr/` |
| Runbooks (e-mails, jobs, audit, plans et quotas, rapport) | `docs/runbooks/` |
| Conventions de travail | `CLAUDE.md` |

Structure du monorepo : `apps/web` (Next.js), `apps/worker` (worker de jobs), `packages/domain` (règles métier et validation), `packages/permissions` (droits), `packages/adapters` (intégrations), `supabase/` (migrations, politiques RLS, tests).

---

## 15. Ce que contient le projet (J0 à J25)

| Phase | Jours | Contenu | Écran ? |
|---|---|---|---|
| 0 — Cadrage | J0–J3 | Analyse de la spec, ADR 001 à 016, plan, menaces (STRIDE), backlog, checkpoint C0 | non (documents dans `docs/`) |
| 1 — Fondations | J4–J15 | Monorepo, environnements et secrets, schéma multi-entreprise et RLS, connexion fr/ar/en, organisations, membres et invitations, rôles, couche de services, audit, file de jobs et worker, plans et quotas, SMTP, apparence | oui |
| 2 — Ventes et CRM | J16–J25 | Projets et produits (+ fichiers), contacts et consentement, pipelines, leads, deals, activités, capture publique, assignation automatique, import CSV, écrans Leads/Deals, synchronisation CRM (interne + CSV) | en partie |

Pas d'écran (API, worker ou tests seulement) : import CSV, capture de leads par formulaire, clés de formulaire, règles d'assignation, contacts et consentement, activités.

Pas encore livré : J26 (tests ventes) et J27 (checkpoint C2 / Gate G2), puis les phases suivantes du plan (e-mail, WhatsApp, campagnes, IA).

---

## 16. Parcours de démonstration

Pré-requis : §4 à §6 faits (base démarrée et réinitialisée, `.env.local` rempli, `pnpm dev` lancé), puis :

1. Ouvrir `http://127.0.0.1:3000/fr/login`, se connecter avec `shared@seed.test` (mot de passe : `dev_password` dans `supabase/seed.sql`), choisir **Alpha**.
2. **Phase 1** : *Membres* (liste, invitation), *Paramétrage* (couleurs, logo, SMTP), puis *Administration* (liste des organisations, réservée à l'administrateur de la plateforme). Changer la langue en `/ar` : la page s'inverse (droite-gauche).
3. **Phase 2** : *Projets* (création par type), *Leads*, *Deals*, *CRM*. Après un `db:reset`, ces listes sont **vides** : le seed ne crée pas de leads. Pour les remplir, créer des données par les tests d'acceptation (`pnpm test:e2e`) ou par l'API (import CSV : `POST /api/imports`, voir `docs/api/imports.md` ; fichier d'exemple `tests/fixtures/leads-100.csv`).
4. **Preuves de sécurité sans écran** : `pnpm test:rls` (chaque rôle ne voit que son entreprise) et `pnpm test:db` (audit non modifiable, quotas, jobs).

Pour montrer l'isolation à la main : se connecter avec `beta-owner@seed.test` et constater qu'aucune donnée d'Alpha n'apparaît.

---

## 17. Checklist « nouveau PC »

- [ ] Git, Node 24.13.1 (`nvm use`), pnpm 12.18.0 (`corepack enable`), Docker Desktop **démarré**
- [ ] `git clone` puis `git checkout day-25-crm-adapter`
- [ ] `pnpm install`
- [ ] `pnpm db:start` puis `pnpm db:reset` (refaire `db:reset` à chaque changement de branche)
- [ ] `cp .env.development.example .env.local`, puis recopier `PUBLISHABLE_KEY` et `SECRET_KEY` de `pnpm exec supabase status -o env`
- [ ] `pnpm dev` puis http://127.0.0.1:3000/fr/login
- [ ] (facultatif) `pnpm worker:dev` dans un second terminal
- [ ] `pnpm lint && pnpm typecheck && pnpm test` : tout vert

**À ne pas copier d'un PC à l'autre** : `.env`, `.env.local`, `supabase/.env`, `node_modules/`, `.turbo/`. Chaque machine génère ses propres clés locales (`supabase status`).
