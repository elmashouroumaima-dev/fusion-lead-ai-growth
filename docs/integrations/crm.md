# Intégration — CRM Fusion Leap

- **Spec :** §5.9, §9.1 (encadré « Fusion Leap CRM »), §14 Q1, §6 (adapters)
- **Consultée le :** 2026-11-05. **Aucune information sur le CRM existant n'est disponible dans le dépôt** : tout ce qui suit est **À CONFIRMER** par la responsable technique (la spec lui demande de documenter nature, API, authentification, champs, webhooks et limites avant tout connecteur direct).

## Décision actuelle (hypothèse §14 confirmée)
**CRM interne = source de vérité au MVP**, avec import/export CSV. Aucun connecteur direct, aucune synchronisation bidirectionnelle sans règles de conflit documentées (spec §9.1).

## À documenter par la responsable technique (Q1)
| Point | Réponse |
|---|---|
| Nom et type du CRM actuel | **À CONFIRMER** |
| API disponible et stable ? (REST/GraphQL, version) | **À CONFIRMER** |
| Authentification (OAuth2, clé API, scopes) | **À CONFIRMER** |
| Objets et champs lead/deal (identifiants, statuts, champs personnalisés) | **À CONFIRMER** |
| Webhooks (événements, signature, reprises) | **À CONFIRMER** |
| Limites de débit | **À CONFIRMER** |
| Environnement de test / sandbox | **À CONFIRMER** |

## Interface (spec §6)
`CrmAdapter { connect, validate, send, receive, refresh, disconnect }` dans `packages/adapters/crm`. Implémentations MVP : `internal` (source de vérité) et `csv`. Si l'API Fusion Leap CRM se révèle documentée et stable : **squelette seulement** (J25), sans synchro bidirectionnelle.

## Règles de synchronisation prévues
- `crm_field_mappings (champ interne ↔ champ externe, source_of_truth, direction)` et `external_id` stable ; `unique (organization_id, external_source, external_id)`.
- Résolution de conflit : `source_of_truth` par champ + date de dernière modification ; le perdant est consigné dans l'audit.
- Statut de synchro et dernière erreur visibles ; bouton « réessayer » ; idempotence par `external_id`.

## Plan B
CRM interne + export/import CSV (déjà le défaut). Si l'API arrive après le MVP : backlog post-MVP « synchro bidirectionnelle ».

## Mise en œuvre J25 (2026-11-08)
Interface `CrmAdapter`, adaptateurs `internal` et `csv`, `crm_field_mappings`, moteur de conflit et job `crm_sync` (contacts) livrés : voir `docs/api/crm-sync.md`. **Aucun squelette du CRM Fusion Leap** : l'API n'est pas documentée (Q1 toujours à confirmer) ; il sera ajouté quand la responsable technique aura renseigné le tableau ci-dessus.
