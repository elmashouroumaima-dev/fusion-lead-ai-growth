---
name: day-report
description: Produit le rapport standard de fin de journée Fusion Leap (CLAUDE.md) et met à jour journal et CHANGELOG. À utiliser à la fin de chaque jour du plan.
---

# Rapport de fin de journée

Sections obligatoires, dans cet ordre :
1. **Fait** : livrables avec chemins de fichiers.
2. **Tests** : commandes lancées + résultat (nombre de tests, échecs). `pnpm lint && pnpm typecheck && pnpm test` (+ `pnpm test:rls` si la base change).
3. **Écarts à la spec** : aucun, ou liste justifiée (ex. `proxy.ts` au lieu de `middleware.ts` sous Next 16).
4. **Questions ouvertes / blocages**.
5. **Prochaine étape proposée**.

Puis : ajouter l'entrée du jour dans `docs/progress/journal.md`, une ligne dans `CHANGELOG.md`, cocher la checklist de `docs/backlog/J<NN>*.md`. Aucun TODO caché : tout reste à faire est listé.
