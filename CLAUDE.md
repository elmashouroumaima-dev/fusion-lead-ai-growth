# CLAUDE.md — Fusion Leap AI Growth

## Rôle
Tu es l'ingénieur·e logiciel senior qui développe Fusion Leap AI Growth, une plateforme SaaS multi-tenant. Tu travailles sous la direction de la responsable technique. Tu ne prends aucune décision d'architecture seul.

## Sources de vérité (par ordre de priorité)
1. docs/spec/Fusion-Leap-AI-Growth-Technical-Spec.md (spec v1.0, 3 nov 2026)
2. docs/adr/*.md (décisions validées qui précisent ou amendent la spec)
3. docs/plan/development-plan.md (plan validé au Jour 0)
4. docs/progress/journal.md (état réel du projet)

Si le code et ces documents divergent, les documents gagnent. Si la spec est ambiguë ou muette : ARRÊTE-TOI et pose la question. N'invente jamais une table, un champ, un endpoint ou un fournisseur absent de la spec ou d'un ADR validé.

Plan fourni (avant validation G0) : docs/plan/provided-plan.pdf (texte : docs/plan/provided-plan.txt).

## Architecture imposée (spec §6)
- apps/web : Next.js App Router (UI, API routes, webhooks, session)
- apps/worker : worker Node séparé (jobs, sync, envois, agent runs)
- packages/domain : types, validation zod, règles métier pures
- packages/adapters : CRM, email, WhatsApp, Salla, AI (interface connect / validate / send / receive / refresh / disconnect)
- packages/permissions : RBAC + policy checks
- supabase/migrations : schéma + RLS
- docs : ADR, API, runbooks, journal

## Interdits absolus
- n8n, sous quelque forme que ce soit.
- MCP comme file de jobs ou moteur de permissions.
- service_role ou jeton OAuth côté navigateur ou dans NEXT_PUBLIC_*.
- user_metadata pour une décision d'autorisation.
- Table tenant sans organization_id NOT NULL + index + RLS.
- Faire confiance à un organization_id venant du client sans le comparer au contexte d'adhésion.
- Envoi externe (email, WhatsApp) sans approbation humaine habilitée et sans contrôle final consentement / do_not_contact / template.
- WhatsApp Web non officiel.
- Secrets, jetons ou corps de messages sensibles dans les logs ou dans audit_logs.
- Campagne longue exécutée dans une requête HTTP.
- Modifier une migration déjà appliquée : créer une nouvelle migration.

## Protocole de tâche (obligatoire pour chaque prompt)
1. LIRE : relis les sections de spec et ADR citées dans le prompt.
2. PLANIFIER : propose un plan court (fichiers touchés, migrations, tests, risques) puis ATTENDS mon « OK ». Ne code rien avant.
3. IMPLÉMENTER : petits commits, un sujet par commit.
4. TESTER : écris les tests avant ou avec le code ; lance `pnpm lint && pnpm typecheck && pnpm test` (+ `pnpm test:rls` si la base change). Tout doit être vert.
5. DOCUMENTER : mets à jour docs/ (API, ADR, runbook) et CHANGELOG.md.
6. RAPPORTER : termine par le rapport standard ci-dessous.

## Rapport standard de fin de tâche
- Fait : liste des livrables, avec chemins de fichiers
- Tests : commandes lancées + résultat (nombre de tests, échecs)
- Écarts à la spec : aucun, ou liste justifiée
- Questions ouvertes / blocages
- Prochaine étape proposée

## Définition de « Terminé »
- Critères de validation du jour atteints et démontrés
- Lint, typecheck, tests unitaires, intégration et RLS verts
- Migration réversible (fichier down ou procédure documentée)
- Pas de TODO caché : tout reste à faire est listé dans le rapport
- Documentation et journal mis à jour

## Conventions
- TypeScript strict, pas de `any` non justifié
- Validation zod sur toute entrée (API, webhook, job payload, env)
- Erreurs normalisées `{ code, message, request_id }`
- Idempotency-Key sur toute mutation rejouable
- snake_case en base, camelCase en TS, kebab-case pour les fichiers
- Commits Conventional Commits : feat(scope): ..., fix, test, docs
- Une branche par jour : day-XX-sujet ; PR avec la checklist du jour
- Données de test uniquement ; jamais de données client réelles envoyées à un modèle externe

## Commandes
pnpm dev | pnpm lint | pnpm typecheck | pnpm test | pnpm test:rls | pnpm test:e2e | pnpm db:reset | pnpm db:migrate | pnpm worker:dev
