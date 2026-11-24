# ADR 018 — Comptes fournisseur par entreprise et résolution des webhooks par signature

- **Statut :** Proposed (approche choisie le 2026-11-24 sur délégation de la responsable technique après la revue de sécurité S-02 ; à valider)
- **Date :** 2026-11-24
- **Section de spec :** §8 (webhooks), §11 ; ADR 007 (E4), ADR 008, ADR 017 ; menaces C (webhooks) ; `docs/security/phase3-review-pack.md` (S-02)

## Contexte
L'index unique `integrations_provider_account_global` (provider, external_account_id) était global et sans filtre d'état. Rien ne prouve qu'une entreprise possède le numéro WhatsApp ou le domaine d'e-mail qu'elle déclare (la validation d'un jeton Postmark ou Resend ne le lie pas au compte). Conséquences relevées par la revue : une entreprise pouvait bloquer la connexion d'une autre (déni de service entre entreprises), les webhooks de la victime se résolvaient vers la mauvaise ligne, la déconnexion ne libérait pas le compte, et la réponse 409 révélait qu'un compte était pris.

## Options comparées
| | A. Résolution par signature (retenue) | B. Index unique partiel sur `active` + preuve de propriété | C. Libérer à la déconnexion seulement |
|---|---|---|---|
| Déni de service entre entreprises | Supprimé : plus de réservation | Subsiste pour l'e-mail (Resend avec une clé « envoi seul » et Postmark ne prouvent pas le domaine) | Subsiste |
| Oracle « ce compte est pris » | Supprimé | Subsiste | Subsiste |
| Fuite d'événements entre entreprises | Impossible : seule la signature du vrai propriétaire est valide | Idem | Idem |
| Coût | Migration + boucle de vérification + tests | Preuve de propriété à bâtir par fournisseur | Faible |

## Décision
**Option A.**
- L'unicité est **par entreprise** (`integrations_org_account_key` : entreprise, fournisseur, compte), qui existait déjà. Deux entreprises peuvent déclarer le même compte ; le doublon dans une même entreprise reste un 409.
- `webhook_resolve_candidates` remplace `webhook_resolve_integration` : elle renvoie jusqu'à 5 intégrations candidates (actives d'abord, puis en erreur, puis en attente), filtrées par fournisseur, compte et passerelle (état `pending`, `active` ou `error` seulement).
- Le pipeline `ingestWebhook` essaie le **secret de webhook de chaque candidate** : la signature (HMAC, Svix, Basic Auth) désigne l'entreprise. Un événement authentique du fournisseur n'est signé que pour son vrai propriétaire ; un attaquant ne reçoit que ses propres événements, signés avec son propre secret.
- Sans candidate ou sans signature valide : même réponse 401. Le refus est tracé (métadonnées seules, sans contenu) pour **chaque** candidate.

## Conséquences
- Au plus 5 lectures de secret par webhook (borne dure dans la fonction SQL).
- La déconnexion libère le compte pour les autres entreprises sans autre mécanisme ; la reconnexion d'une adresse dans la même entreprise réutilise la ligne existante (« Reconnecter »).
- Le test d'acceptation « Beta ne connecte pas le même compte (409) » devient « Beta peut le déclarer (201), mais ni remplacer ni déconnecter la ligne d'Alpha (404) ».
- L'envoi n'est pas concerné : il utilise la clé de l'entreprise qui envoie ; le fournisseur refuse d'envoyer d'un domaine qui n'est pas à elle.
- Limite : une entreprise peut afficher des intégrations « en attente » pour des comptes qu'elle ne possède pas ; elles ne reçoivent que des événements signés par un secret qu'elle a elle-même choisi.
- Retour arrière : `supabase/rollbacks/20261220100000_integration_account_per_org.sql` (échoue si des doublons existent ; la requête de contrôle y est fournie).
