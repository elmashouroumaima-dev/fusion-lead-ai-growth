---
name: rls-test-writer
description: Écrit des tests RLS pour Fusion Leap via la Data API (harnais supabase/tests/rls). À utiliser pour toute nouvelle table ou politique.
---

# Tests RLS

Utiliser `supabase/tests/rls/src/harness.ts` (`api`, `select`, `rowsOf`, `isDenied`, personas Alpha/Beta). Pour chaque table et chaque opération (select/insert/update/delete) :
- anon → refusé ;
- utilisateur sans adhésion → aucune ligne ;
- autre entreprise (Beta) → aucune ligne, écriture refusée ;
- chaque rôle (owner, admin, marketing, sales, analyst) → conforme à la matrice ADR 014 ;
- `organization_id` forgé à l'écriture → refusé ;
- restaurer les fixtures après tout test mutant (`restoreFixtures`).
Ajouter aussi la table aux règles de `900_schema_lint.test.sql` si une exception est nécessaire (justifiée en revue). Test mutation : casser la politique doit faire échouer le test.
