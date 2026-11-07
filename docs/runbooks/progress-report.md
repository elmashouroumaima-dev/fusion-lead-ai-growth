# Rapport d'avancement (PDF) : régénéré à chaque commit

Le rapport `docs/progress/report/Rapport-avancement_AAAA-MM-JJ.pdf` (et sa source HTML) est **régénéré à chaque commit** de travail, pour que le PDF reflète toujours l'état réel du projet. Un fichier par jour : la génération du jour remplace celle du matin (le dépôt ne grossit pas à chaque commit).

## Commande
```bash
pnpm report:progress          # HTML + PDF (Chrome headless)
pnpm report:progress --html   # HTML seulement
```
Chrome est détecté automatiquement (sinon `CHROME_PATH`). Les PR (créées, fusionnées, en revue) sont lues avec `gh` si disponible ; la date et le commit viennent de git.

## Quoi mettre à jour avant de lancer la commande
Tout vient de `scripts/progress-report/data.json` :
- `phases[].modules[]` : `progress` (0 à 100) et `status` (`done`, `review` = PR ouverte, `part` = fait mais à valider, `todo`). L'avancement global et par phase est **calculé** (jours réalisés ÷ 63).
- `tests` : nombres issus du dernier passage de `pnpm test`, `pnpm test:db`, `pnpm test:rls`.
- `extras`, `openPoints`, `nextSteps`, `summary` : textes du rapport.

## Procédure à chaque commit
1. Mettre à jour `data.json` si l'état a changé (module terminé, PR fusionnée, nouveaux chiffres de tests, points ouverts).
2. `pnpm report:progress`.
3. Inclure `docs/progress/report/` (HTML et PDF du jour) et `scripts/progress-report/data.json` dans le commit de documentation.

Une PR fusionnée fait passer le module de `review` à `done` ; la date de fin du jour change le fichier produit.
