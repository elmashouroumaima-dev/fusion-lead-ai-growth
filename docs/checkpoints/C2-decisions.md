# Checkpoint C2 — Décisions demandées à la responsable technique

Contexte : `docs/checkpoints/C2.md` (audit de la Phase 2, 0 bloquant, 3 majeurs). Le plan (§15) dit : sans GO écrit, la Phase 3 ne démarre pas. Quatre décisions sont nécessaires. L'ingénieur·e propose, la responsable technique tranche.

## 1. GO / NO-GO du checkpoint C2
| Option | Effet |
|---|---|
| **GO avec réserves** (proposé) | J28 (Intégrations et secrets) démarre ; les écarts 1 à 3 restent au registre avec une échéance. |
| GO sans réserve | Non recommandé : l'écart 1 (interface absente) est réel. |
| NO-GO | La Phase 3 attend la correction des écarts 1 à 3. |

## 2. Écrans manquants (écart 1) : avant G3 ou G2 « au niveau API » ?
Aujourd'hui aucun écran ni route ne permet de : créer un lead ou un deal, noter une activité, voir la chronologie, gérer les clés de formulaire, les règles d'assignation, les contacts et le consentement, importer un fichier. Le critère §13-4 (« visible ») est démontré au niveau service, API et base.

| Option | Coût estimé | Remarque |
|---|---|---|
| **A. Planifier avant G3** une fiche lead (chronologie, note, création de deal) puis les écrans de configuration (clés, règles, import) | à chiffrer (plusieurs jours, à insérer dans la Phase 3) | Le parcours devient réalisable par un utilisateur ; recommandé avant tout pilote. |
| B. Accepter G2 « au niveau API » et reporter les écrans après G3 | 0 maintenant | Risque : les canaux (e-mail, WhatsApp) s'appuient sur la boîte de réception, qui a besoin de la fiche lead. |

## 3. ADR toujours « Proposed »
Les ADR 001 à 008, 010 à 012 et 014 à 016 sont à relire. Les 8 tables ajoutées en Phase 2 hors spec §7 (`pipelines`, `pipeline_stages`, `notifications`, `assignment_rules`, `crm_field_mappings`, `form_keys`, `import_batches`, `import_rows`) reposent sur l'ADR 007. Le CLAUDE.md exige un ADR validé. Action attendue : accepter ou amender, et ajouter à l'ADR 005 une ligne sur le modèle « lecture par politique, écriture par fonctions `SECURITY DEFINER` ».

## 4. Job CI de bout en bout (écart 3)
`test:e2e` (T1, T2, G2) et `test:coverage` ne tournent pas en CI : les tests d'acceptation exigent l'application démarrée.

| Option | Remarque |
|---|---|
| **A. Job CI dédié** : pile Supabase locale, `pnpm build` puis démarrage de l'application, `pnpm test:e2e`, plus `test:coverage` sur `domain` et `permissions` | Recommandé ; allonge la CI de quelques minutes. |
| B. Lancer ces tests à la main avant chaque checkpoint | Gratuit mais sans garde-fou. |

## Questions ouvertes liées
- Q1 : l'API du CRM Fusion Leap est-elle documentée ? Sans réponse, pas d'adaptateur réel (CRM interne et CSV seulement).
- Playwright (binaires de navigateur) : à installer ou à garder en HTTP ? Réserve C1 n°2 toujours ouverte.
- `libphonenumber-js` : épingler la version exacte (aujourd'hui `^1.13.15`).
