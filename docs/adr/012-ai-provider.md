# ADR 012 — Fournisseur IA et politique de données

- **Statut :** Proposed — **hors stack imposée : accord explicite requis**
- **Date :** 2026-11-11
- **Section de spec :** §9.5, §6 (adapter AI), §11, §13-8

## Contexte
Les agents IA (Research, Campaign, Lead Qualification, Reply, Analyst) ne produisent que des brouillons/suggestions. La spec impose : contexte isolé par entreprise et projet, pas de secrets dans le contexte, traçabilité (`prompt_version`, modèle, coût approximatif, sources, décision du relecteur), budget et limite de temps par entreprise, messages entrants traités comme données non fiables, et **aucune donnée client envoyée à un modèle externe avant documentation des conditions de service, de la rétention et du consentement**. Aucun fournisseur n'est nommé.

## Décision recommandée
1. **Interface `AiAdapter`** indépendante du fournisseur (`complete(prompt, options) → { text, usage }`), implémentée une fois pour le fournisseur choisi et une fois par un **adaptateur factice déterministe** pour les tests et la CI.
2. **Fournisseur** : à choisir par la responsable technique **avant le J47**, après lecture de ses conditions d'utilisation, de rétention et de traitement des données (§9.5). Aucun choix n'est fait ici.
3. **Politique de données (bascule `AI_ALLOW_REAL_DATA`, défaut `false`)** : en développement, staging et CI, **données de test uniquement** ; en production, activation par entreprise seulement après (a) documentation CGU/rétention du fournisseur, (b) base légale/consentement, (c) accord explicite.
4. **Minimisation** : le contexte est construit par des fonctions de lecture filtrées par `organization_id`/`project_id`, avec liste blanche de champs ; pas de e-mail/téléphone si non nécessaires ; jamais de secret.
5. **Entrées non fiables** : le contenu client est encadré par un délimiteur explicite dans le prompt, accompagné d'une consigne d'ignorer toute instruction qu'il contient ; les agents n'ont **aucun outil de mutation** au MVP.
6. **Gouvernance** : chaque exécution écrit une ligne `agent_runs` (prompt_version, modèle, tokens, coût estimé, sources, statut, relecteur) ; budget mensuel en `usage_counters` et délai maximal par appel ; échec/timeout → statut `timeout`/`failed`, aucun effet de bord.
7. **Prompts** versionnés dans le dépôt (`packages/domain/prompts/…`), `prompt_version` = identifiant de version.

## Alternatives
Appels directs au SDK d'un fournisseur depuis les routes : rejeté (couplage, non testable, contourne budget et audit).

## Conséquences
J47 peut démarrer avec l'adaptateur factice si le fournisseur n'est pas choisi ; la suite d'injection (J50) tourne sur l'adaptateur factice et sur le fournisseur réel avec données de test.
