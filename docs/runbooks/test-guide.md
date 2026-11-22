# Runbook — Guide de tests fonctionnels (PDF) et outils de recette

**Un seul PDF** regroupe tous les guides de test : `docs/testing/Guide-test-complet.pdf` (couverture, sommaire, signets, une fiche de résultats par partie). C'est le seul PDF du dossier `docs/testing/` ; ses parties vivent dans `docs/testing/parts/`.

## Régénérer le PDF (à chaque ajout ou modification)
```bash
pnpm test:guide            # reconstruit docs/testing/Guide-test-complet.pdf (Chrome headless ; CHROME_PATH ; python + pypdf)
```

## Ajouter quelque chose au guide
1. Déposer le contenu dans `docs/testing/parts/` : un fichier **`.md`** (le plus simple : tableaux de cas avec l'`ID` en première colonne, la fiche de résultats OK / KO est générée), un **`.html`** (rendu par Chrome) ou un **`.pdf`** (repris tel quel). Un `.md` déjà existant ailleurs peut être référencé par son chemin (par exemple `../phase2-3-functional-tests.md`).
2. Ajouter une ligne dans `docs/testing/parts/parts.json` : `file`, `tag` (court : « Phase 3 »), `title`. L'ordre du fichier est l'ordre du PDF.
3. Lancer `pnpm test:guide`.

Parties actuelles : phase 1 (comptes et rôles), phase 2 (CRM), recette détaillée des phases 2 et 3 (source `phase2-3-functional-tests.md`), phase 3 (conversations et envoi, boîte de réponses, exploitation et configuration), checkpoint C3 (test réel Postmark, WhatsApp Kapso ; source `07-c3-test-reel.html`).
Sous-ensemble de Markdown pris en charge : titres, paragraphes, listes (avec blocs de code), tableaux, blocs de code, citations. Le tableau d'un cas de test a `ID` en première colonne (A1, B12, T6.3...).
Un guide Markdown seul se produit aussi à la main : `node scripts/test-guide/build-pdf.mjs <guide.md> <sortie.pdf>` (`--html` : HTML seulement).

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
