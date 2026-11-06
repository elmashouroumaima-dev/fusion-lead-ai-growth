# ADR 010 — Hébergement et déploiement

- **Statut :** Proposed — **hors stack imposée : accord explicite requis** ; **dépend de Q5** (marché, protection des données), sans réponse à ce jour
- **Date :** 2026-11-11
- **Section de spec :** §6 (environnements dev/staging/production séparés), §11 (région des données, accords juridiques), §12 phase 5, §14 Q5

## Contexte
La spec exige trois environnements séparés et demande de fixer la région des données et les accords avant un lancement commercial, « surtout si l'Arabie saoudite est ciblée » (§11). Aucun hébergeur n'est nommé. Le plan en a besoin au plus tard au J58 (staging).

## Fait vérifié (2026-11-05)
La page des régions de Supabase (https://supabase.com/docs/guides/platform/regions) liste des régions Europe (Irlande, Londres, Paris, Francfort, Zurich, Stockholm), Amériques, Asie-Pacifique (Mumbai, Singapour, Tokyo, Séoul, Sydney) : **aucune région Moyen-Orient (Bahreïn/Émirats) n'y figure**. La page n'indique pas si la région peut être changée après création → **À CONFIRMER**. Elle précise qu'une région générale peut ne pas correspondre à une juridiction donnée.

## Décision recommandée (à valider)
1. **Base/Auth/Storage** : un projet Supabase par environnement (dev local Docker, staging, production). Région : **à décider avec Q5** ; en l'absence de contrainte légale connue, choisir la région supportée la plus proche du marché (Europe) et **documenter le risque de résidence des données** pour l'Arabie saoudite. Le choix de région est considéré **irréversible** tant que la doc ne dit pas le contraire.
2. **apps/web** : hébergeur compatible Next.js App Router avec variables d'environnement serveur secrètes.
3. **apps/worker** : conteneur Node long-lived (process continu, SIGTERM propre), une réplique minimum pour le staging, plusieurs possibles (lease).
4. Le **fournisseur concret** (web et worker) n'est pas fixé ici : à choisir par la responsable technique avant **J3** selon coût, région et exigences de secret manager. L'ADR sera complété avec ce choix.
5. **Secrets** : gestionnaire de secrets de l'hébergeur ; clé maîtresse ADR 004 distincte par environnement.
6. **CI/CD** : GitHub Actions ; déploiement staging manuel déclenché depuis `main` ; migrations appliquées par la CI avant le déploiement des applications.

## Alternatives
Auto-hébergement complet (Docker/VPS) : plus de contrôle de région, mais charge d'exploitation et sauvegardes à notre charge ; écarté sauf contrainte de résidence.

## Conséquences
Q5 devient bloquante pour la production (pas pour le dev/staging). Risque R-new : résidence des données non satisfaisable avec Supabase si le Moyen-Orient est exigé.
