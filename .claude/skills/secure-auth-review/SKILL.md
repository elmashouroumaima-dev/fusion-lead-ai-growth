---
name: secure-auth-review
description: Checklist de revue sécurité pour le code Auth/session/redirection de Fusion Leap (Supabase SSR + Next.js). À utiliser avant de valider tout code touchant login, cookies, proxy, server actions ou redirections.
---

# Revue sécurité Auth/session

Parcours chaque point ; rapporte chaque violation avec fichier:ligne, gravité, correctif.

1. **Identité côté serveur** : `supabase.auth.getClaims()` (ou `getUser()`), jamais `getSession()` pour décider d'un accès. Jamais `user_metadata` pour l'autorisation.
2. **Cookies** : `setAll` écrit sur requête ET réponse ; un seul endroit rafraîchit la session (le proxy) ; en-têtes anti-cache appliqués aux réponses portant `Set-Cookie`.
3. **Redirections** : paramètre `next` / `redirectTo` accepté seulement s'il commence par un seul `/` (pas `//`, pas `\`, pas de schéma). Test avec `//evil.com`, `/\evil.com`, `https://evil.com`, `javascript:`.
4. **Secrets** : aucun `SUPABASE_SECRET_KEY`/service_role dans le code navigateur ni dans `NEXT_PUBLIC_*` ; client navigateur = clé publishable uniquement.
5. **Énumération de comptes** : messages d'erreur identiques que le compte existe ou non (login, reset, signup).
6. **Validation** : toute entrée (formulaire, query, cookie de locale) passe par zod.
7. **Erreurs** : forme `{ code, message, request_id }` ; aucune trace, jeton, mot de passe ni e-mail complet dans les logs.
8. **CSRF/actions** : mutations uniquement via Server Actions ou POST ; pas de mutation en GET.
9. **Rate limit / abus** : noter ce qui relève de Supabase Auth (limites natives) et ce qui reste à faire (J57).
10. **Mots de passe** : jamais journalisés, jamais renvoyés au client ; politique minimale documentée.
