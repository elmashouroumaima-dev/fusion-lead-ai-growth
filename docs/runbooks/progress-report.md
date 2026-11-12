# Rapport d'avancement (PDF) : régénéré à chaque commit

Le rapport `docs/progress/report/Rapport-avancement_AAAA-MM-JJ.pdf` (et sa source HTML) est **régénéré à chaque commit** de travail, pour que le PDF reflète toujours l'état réel du projet. Un fichier par jour : la génération du jour remplace celle du matin (le dépôt ne grossit pas à chaque commit).

## Commande
```bash
pnpm report:progress          # HTML + PDF (Chrome headless)
pnpm report:progress --html   # HTML seulement
```
Chrome est détecté automatiquement (sinon `CHROME_PATH`). Les PR (créées, fusionnées, en revue) sont lues avec `gh` si disponible ; la date et le commit viennent de git.

## Contenu (8 pages) et historique
Synthèse (chiffres clés, « depuis le dernier rapport », faits marquants), **journal du jour** (une phrase par étape, activités repliées, vignettes, lignes ajoutées/retirées), feuille de route (jalons, courbe d'avancement, phases), phases 0 et 1 avec les ajouts hors plan, phases 2 à 5, livré récemment (J28 à J32, avec les revues de sécurité), qualité (tests par catégorie et au fil du temps, revues adverses) et décisions à prendre. `scripts/progress-report/history.json` garde **une ligne par jour** (avancement, jours, nombre de tests) : il alimente la comparaison avec le rapport précédent et les courbes ; il est mis à jour par la commande et doit être commité avec le rapport. Le nombre d'ADR acceptés est lu dans `docs/adr/`, les PR avec `gh`.

## Quoi mettre à jour avant de lancer la commande
Tout vient de `scripts/progress-report/data.json` :
- `phases[].modules[]` : `progress` (0 à 100) et `status` (`done`, `review` = PR ouverte, `part` = fait mais à valider, `todo`). L'avancement global et par phase est **calculé** (jours réalisés ÷ 63).
- `tests` : nombres issus du dernier passage de `pnpm test`, `pnpm test:db`, `pnpm test:rls`.
- `extras`, `milestones`, `recent` (livraisons récentes et revues de sécurité), `capabilities` (déjà possible / pas encore), `openPoints` (point, responsable, échéance), `nextSteps`, `summary` : textes du rapport.

## Procédure à chaque commit
1. Mettre à jour `data.json` si l'état a changé (module terminé, PR fusionnée, nouveaux chiffres de tests, points ouverts).
2. `pnpm report:progress`.
3. Inclure `docs/progress/report/` (HTML et PDF du jour) et `scripts/progress-report/data.json` dans le commit de documentation.

Une PR fusionnée fait passer le module de `review` à `done` ; la date de fin du jour change le fichier produit.

## Page « journal du jour »
Section `journal` de `data.json` : chaque étape a une `sentence` (une phrase de narration), des `actions` (lignes repliées), un `grep` (expression régulière sur les messages de commit du jour, pour compter les lignes +/−) et des `thumbs` facultatifs (`[fichier, légende]`, PNG dans `docs/progress/report/journal/`). Les compteurs viennent de `git log --all --no-merges --numstat` depuis minuit ; une étape sans `grep` n'affiche pas de compteur. Les actions sont écrites à la main : n'y mettre que ce qui a vraiment été fait.
