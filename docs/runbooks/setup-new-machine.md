# Runbook — Démarrer le projet sur une nouvelle machine

Objectif : cloner le dépôt et faire tourner l'application, le worker et les tests en local (Supabase dans Docker). Rien de ce qui tourne dans Docker ne se copie d'une machine à l'autre : les conteneurs sont **jetables** et se recréent à partir du code (migrations et données de test).

## 1. Prérequis
| Outil | Version | Remarque |
|---|---|---|
| Git | récent | |
| Node.js | **22.12 ou plus** (`engines` du `package.json` ; 24 recommandé) | une version plus ancienne fait échouer `pnpm dev` (erreur `require() of ES Module` sur `magic-string` / Tailwind) |
| pnpm | via Corepack (`corepack enable`) | la version est fixée par le dépôt (`packageManager`) |
| Docker Desktop | récent, **démarré** | prévoir quelques Go de mémoire pour Docker (la pile Supabase locale en utilise environ 2 Go) |

Vérifier : `node -v`, `pnpm -v`, `docker ps` (doit répondre sans erreur).

## 2. Récupérer le code
```bash
git clone <url-du-depot> fusion-lead-ai-growth
cd fusion-lead-ai-growth
git checkout <branche-du-jour>   # une branche par jour : day-XX-sujet
pnpm install
```

## 3. Démarrer Supabase local
```bash
pnpm db:start
```
Le premier démarrage télécharge les images Docker (quelques minutes) : base Postgres, API (PostgREST), authentification, stockage, temps réel, Studio, Mailpit (boîte de capture des e-mails), etc. Deux conteneurs peuvent rester arrêtés (`edge_runtime`, `vector`) : le projet n'en a pas besoin.

Créer le schéma et les données de test :
```bash
pnpm db:reset
```
Cela applique toutes les migrations de `supabase/migrations/` puis `supabase/seed.sql`. Les données sont **uniquement des données de test** : aucune donnée client réelle ne doit entrer dans cette base.

## 4. Fichier d'environnement
Le fichier `.env.local` n'est **jamais** dans git (il contient des secrets) et ne se copie pas d'une machine à l'autre : on le recrée.

1. Copier le modèle : `cp .env.development.example .env.local`
2. Lire les valeurs locales de cette machine : `pnpm exec supabase status -o env`
3. Remplir dans `.env.local` :
   - `NEXT_PUBLIC_SUPABASE_URL` et `SUPABASE_URL` : `API_URL` (en général `http://127.0.0.1:54321`)
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` : `PUBLISHABLE_KEY` (clé publique, sans danger côté navigateur)
   - `SUPABASE_SECRET_KEY` : `SECRET_KEY` (équivalent service_role : **serveur et worker uniquement**, jamais dans une variable `NEXT_PUBLIC_*`)
   - `SECRETS_MASTER_KEY` : une clé **locale** de 32 octets en base64, à générer sur cette machine :
     ```bash
     node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
     ```
     et `SECRETS_KEY_VERSION=1`. Cette clé chiffre les secrets d'intégration (ADR 004) : une clé différente ne déchiffre pas les secrets enregistrés avec une autre ; en local, c'est sans conséquence puisque les données de test se recréent.
   - `AI_ALLOW_REAL_DATA=false` (ne jamais le changer en local, ADR 012).
4. Les clés Supabase locales sont propres à chaque installation : ne pas réutiliser celles d'une autre machine. Ne jamais envoyer un `.env*` par message, e-mail ou dépôt.

## 5. Lancer l'application
```bash
pnpm dev            # application web : http://127.0.0.1:3000/fr/login
pnpm worker:dev     # worker (jobs : import, synchro, webhooks, envoi), dans un autre terminal
```
Si `pnpm dev` échoue malgré une version de Node correcte, lancer en mode production :
```bash
pnpm build
cd apps/web && node_modules/.bin/next start -p 3000
```
(les variables de `.env.local` doivent être exportées dans le terminal pour `next start`.)

E-mails de la plateforme en local : voir `docs/runbooks/local-email.md` (boîte de capture Mailpit, `http://127.0.0.1:54324`).

## 6. Vérifier que tout fonctionne
```bash
pnpm lint && pnpm typecheck && pnpm test       # unitaires
pnpm test:db                                   # pgTAP (base)
pnpm test:rls                                  # RLS par la vraie API
pnpm check:leaks                               # aucun secret côté navigateur
```
Les tests d'acceptation (`pnpm test:e2e`) exigent l'application déjà démarrée sur le port 3000 avec une clé maître locale ; le job `e2e` de `.github/workflows/ci.yml` montre la séquence complète.

## 7. Arrêter et nettoyer
```bash
pnpm db:stop        # arrête les conteneurs (les données restent dans les volumes Docker)
pnpm db:reset       # repart d'une base propre (migrations + données de test)
```

## 8. Problèmes fréquents
| Symptôme | Cause et remède |
|---|---|
| `docker ps` ou `supabase status` : « 500 Internal Server Error » | le moteur Docker Desktop est bloqué : le redémarrer (Troubleshoot > Restart), au besoin `wsl --shutdown` puis rouvrir Docker Desktop |
| `supabase_db ... is not ready: starting` | attendre quelques secondes que la base soit « healthy », puis relancer la commande |
| `require() of ES Module ... magic-string` au `pnpm dev` | Node trop ancien : installer Node 22.12 ou plus |
| L'application refuse de démarrer (variable manquante) | `.env.local` incomplet : la validation zod au démarrage nomme la variable manquante |
| Port 3000 déjà utilisé | arrêter l'ancien processus (`next start` ou `next dev`) avant de relancer |

## Données : emporter la base d'une autre machine (rare)
Normalement inutile : `pnpm db:reset` recrée tout. Pour copier quand même une base de test : `pg_dump` depuis le conteneur `supabase_db_<projet>` sur l'ancienne machine, puis restauration sur la nouvelle après `pnpm db:start`. Ne jamais faire cela avec des données client réelles.
