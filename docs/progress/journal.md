# Journal de progression — Fusion Leap AI Growth

Avancement réel = somme des heures estimées des tâches **validées** (critères cochés ET tests verts) / 378 h. Code écrit mais non testé = 0 %.

## J00 — lun 9 nov 2026 — Phase 0
Cible : 1,6 % | Réel : en cours | Statut : —

### Tâches
| Tâche | Estimé | Validée |
|---|---|---|
| Préparation du dépôt (CLAUDE.md, spec, plan) | 0,5 h | oui |
| Prompt 0-A : spec-understanding + gaps-and-questions | 1,5 h | oui (en attente de relecture) |
| Prompt 0-B : development-plan.md | 1 h | proposé, en attente de « PLAN VALIDÉ » |
| Relecture, réponses Q1–Q5, validation | 1,5 + 1,5 h | non |

### Validation : message « PLAN VALIDÉ » reçu — plan et D1–D9 retenus (hors ADR 010–012 à confirmer explicitement).
### Tests : n/a (aucun code)
### Écarts à la spec : aucun
### Décisions : hypothèse §14 confirmée pour Q1–Q5 (CRM interne, un fournisseur e-mail, WhatsApp de test, Salla marketing, plans manuels)
### Blocages : aucun
### Demain : J1 (ADR 001–007, ERD) après « PLAN VALIDÉ »

## J01 — mar 10 nov 2026 — Phase 0
Cible : 3,2 % | Réel : à valider | Statut : —

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| ADR 001–006 (stack, monorepo, jobs, secrets, multi-tenancy, conventions) | 2,5 h | oui (Proposed) | en attente de relecture |
| ADR 007 modèle de données réconcilié + ADR 014 matrice RBAC | 2 h | oui (Proposed) | en attente de relecture |
| ERD Mermaid `docs/architecture/erd.md` | 1 h | oui | en attente |
| Revue ERD ↔ spec §7 | 0,5 h | à faire avec la responsable technique | non |

### Tests : n/a (docs)
### Écarts à la spec : platform_admin sort de l'enum des rôles d'organisation (table `private.platform_admins`, ADR 005 §10) — diffère du prompt J6 du plan fourni ; 18 tables ajoutées (« ajout ADR »)
### Décisions / ADR : 001–007, 014 en statut Proposed ; ADR 004 option B (AES-256-GCM applicatif) recommandée après vérification de la doc Supabase Vault (2026-11-05)
### Blocages : relecture sécurité ADR 004/005/014 requise
### Demain : J2 (fiches intégrations, ADR 008/010/011/012, data-flow)

## J02 — mer 11 nov 2026 — Phase 0
Cible : 4,8 % | Réel : à valider | Statut : —

### Tâches
| Tâche | Estimé | Livré | Validée |
|---|---|---|---|
| Fiche CRM | 1 h | oui (tout « À CONFIRMER », aucune info sur le CRM existant) | en attente de Q1 |
| Fiche e-mail + ADR 008 | 1,5 h | oui | en attente de relecture |
| Fiche WhatsApp | 1,5 h | oui (sources Meta citées) | en attente de relecture |
| Fiche Salla | 1 h | oui (sources Salla citées) | en attente de relecture |
| data-flow + ADR 010/011/012 | 1 h | oui | en attente de relecture |

### Tests : n/a (docs)
### Écarts à la spec : aucun
### Constats importants
- Postmark (candidat e-mail) n'a pas de signature HMAC sur ses webhooks (Basic Auth + IP).
- WhatsApp : retries jusqu'à 7 jours (dédup obligatoire) ; webhooks non envoyés en mode dev de l'app ; durée de la fenêtre de service non confirmée.
- Salla : refresh token à usage unique (verrou obligatoire) ; Easy Mode seul autorisé pour apps publiées ; `store_id` non défini, seul `merchant` est documenté.
- Supabase : aucune région Moyen-Orient listée (Q5 à traiter).
### Blocages : Q1, Q2 (domaine), Q5 sans réponse précise ; accès Meta à demander
### Demain : J3 (menaces, stratégie de test, backlog, gate G0')
