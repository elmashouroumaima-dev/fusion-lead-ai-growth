# Rapport d'avancement (PDF) : régénéré à chaque commit

Le rapport `docs/progress/report/Rapport-avancement_AAAA-MM-JJ.pdf` est **régénéré à chaque commit** ; c'est **le seul rapport gardé dans le dossier** (les anciens PDF et les sources HTML sont supprimés à chaque génération, l'historique est dans git) de travail, pour que le PDF reflète toujours l'état réel du projet. Un fichier par jour : la génération du jour remplace celle du matin (le dépôt ne grossit pas à chaque commit).

## Commande
```bash
pnpm report:progress          # HTML + PDF (Chrome headless)
pnpm report:progress --html   # HTML seulement (sans Chrome, rien n'est supprimé)
```
Chrome est détecté automatiquement (sinon `CHROME_PATH`). Les PR (créées, fusionnées, en revue) sont lues avec `gh` si disponible ; la date et le commit viennent de git.

## Contenu (9 pages A4, aux couleurs de l'application) et historique
Mise en page du 22 novembre 2026 : palette de l'application (menthe `#00d4a4`, teal `#00775f`, noir, dégradé de l'en-tête), police Inter (`docs/progress/report/fonts/`).
- **Pour lire** (5 pages) : 1 **Synthèse** (anneau d'avancement, quatre chiffres clés, « en bref » en trois puces, avancement par phase) · 2 **Dernières livraisons** (les quatre plus récentes, avec leurs preuves) · 3 **Ce qui reste** (prochaines étapes, jalons, courbe d'avancement, fonctions possibles ou non) · 4 **Points ouverts** (qui, échéance, en rouge ce qui bloque une étape proche) · 5 **Qualité et sécurité** (tests par catégorie et au fil des jours).
- **Annexes** (4 pages) : phases 0 et 1 · phases 2 et 3 · phases 4 et 5 avec toutes les fonctions disponibles · réalisé en plus du plan.
- L'historique (`scripts/progress-report/history.json`, une ligne par jour) alimente la courbe, le graphique des tests et « depuis le dernier rapport » (affiché seulement si quelque chose a changé).
- La page « journal du jour » de l'ancien design n'est plus produite ; la section `journal` de `data.json` est conservée.

## Quoi mettre à jour avant de lancer la commande
Tout vient de `scripts/progress-report/data.json` :
- `phases[].modules[]` : `progress` (0 à 100) et `status` (`done`, `review` = PR ouverte, `part` = fait mais à valider, `todo`). L'avancement global et par phase est **calculé** (jours réalisés ÷ 63).
- `tests` : nombres issus du dernier passage de `pnpm test`, `pnpm test:db`, `pnpm test:rls`.
- `extras`, `milestones`, `recent` (livraisons récentes et revues de sécurité), `capabilities` (déjà possible / pas encore), `openPoints` (point, responsable, échéance), `nextSteps`, `summary` (texte long, plus affiché) et `brief` (le titre et les trois puces de la page 1 : à relire à chaque rapport) : textes du rapport.

## Procédure à chaque commit
1. Mettre à jour `data.json` si l'état a changé (module terminé, PR fusionnée, nouveaux chiffres de tests, points ouverts).
2. `pnpm report:progress`.
3. Inclure `docs/progress/report/` (le PDF du jour ; les anciens sont supprimés par la commande) et `scripts/progress-report/data.json` dans le commit de documentation.

Une PR fusionnée fait passer le module de `review` à `done` ; la date de fin du jour change le fichier produit.

## Page « journal du jour »
Section `journal` de `data.json` : chaque étape a une `sentence` (une phrase de narration), des `actions` (lignes repliées), un `grep` (expression régulière sur les messages de commit du jour, pour compter les lignes +/−) et des `thumbs` facultatifs (`[fichier, légende]`, PNG dans `docs/progress/report/journal/`). Les compteurs viennent de `git log --all --no-merges --numstat` depuis minuit ; une étape sans `grep` n'affiche pas de compteur. Les actions sont écrites à la main : n'y mettre que ce qui a vraiment été fait.
