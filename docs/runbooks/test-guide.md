# Runbook — Guide de tests fonctionnels (PDF) et outils de recette

Guide pour la personne qui teste les phases 2 et 3 (J16 à J32) : `docs/testing/phase2-3-functional-tests.md` (source) et `docs/testing/Guide-tests-phases-2-3.pdf` (PDF, avec couverture, sommaire et **fiche de résultats** générée à partir des identifiants de cas). Le guide de la Phase 1 reste `docs/testing/phase1-functional-tests.md`.

## Régénérer le PDF
```bash
pnpm test:guide            # PDF (Chrome headless ; CHROME_PATH pour un autre exécutable)
pnpm test:guide --html     # HTML seulement
```
Le PDF se régénère à chaque modification du guide. Sous-ensemble de Markdown pris en charge : titres, paragraphes, listes (avec blocs de code), tableaux, blocs de code, citations. Le tableau d'un cas de test a `ID` en première colonne (A1, B12, T6.3...) : c'est ce qui alimente la fiche de résultats.

## Outils
- `pnpm test:call <compte> <METHODE> <chemin> [corps-json] [--org alpha|beta] [--file fichier]` : appelle l'API de l'application en tant qu'un compte du jeu de test (session, entreprise active et `Idempotency-Key` gérés). Code : `scripts/test-guide/api-call.mts`.
- `docs/testing/fixtures/phase2-demo-data.sql` : 8 contacts, 8 leads, 4 deals (au nom du propriétaire d'Alpha, par les fonctions de l'application).
- `docs/testing/fixtures/create-form-key.sql` : clé de formulaire (affichée une fois) pour la capture publique.
- `docs/testing/fixtures/assignment-rule.sql` : règle d'assignation « chacun son tour ».
- `docs/testing/fixtures/phase3-email-demo.sql` : intégration e-mail et canal actifs, 3 messages « déjà acceptés » (aucun envoi).
- `docs/testing/fixtures/phase3-send-refusals.sql` : approbation de 3 messages que le worker refuse (consentement, suppression, ne plus contacter).
- `docs/testing/fixtures/crm-sync-sample.csv` : fichier de la synchronisation CRM.

## Règles
- Données de test uniquement (domaine `.test`) ; **aucun e-mail réel** n'est envoyé par les scénarios.
- Les résultats attendus du guide ont été **observés** sur l'application réelle (12 novembre 2026). Quand l'application change (libellés, nombres de tests), mettre à jour le guide et régénérer le PDF ; les nombres de tests des suites automatiques (T0) sont ceux du rapport d'avancement.
- Après un test, `pnpm db:reset` remet la base à l'état de départ.
