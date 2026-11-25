# ADR 019 — Défi Cloudflare Turnstile sur la capture publique de leads

- **Statut :** Accepted (2026-11-25, décision de la responsable technique par délégation) ; fournisseur nouveau (Cloudflare Turnstile) accepté. L'exigence du défi (`TURNSTILE_ENFORCE=true`) reste à activer plus tard : clé Turnstile de la plateforme et widget sur les sites clients d'abord
- **Date :** 2026-11-25
- **Section de spec :** §9.1 (capture), §13-3 ; ADR 007 (`form_keys`, J21), ADR 010 (adresse du visiteur) ; `docs/security/phase3-review-pack.md` (S-10)

## Contexte
`POST /api/leads` est public : la clé de formulaire est visible dans la page du site, et `Origin` est forgeable hors navigateur. Un script peut donc vider le seau d'une clé ou le quota « contacts » d'une entreprise, et le 429 `quota_exceeded` révélait l'état du quota.

## Options comparées
| | A. Nonce signé seul | B. hCaptcha | C. Cloudflare Turnstile (retenue) |
|---|---|---|---|
| Arrête un script qui forge `Origin` | Non : le script récupère le nonce dans la page | Oui | Oui |
| Friction visiteur | Aucune | Puzzle fréquent | Défi invisible dans la plupart des cas |
| Données envoyées au tiers | Aucune | Jeton, adresse, signaux navigateur | Jeton, adresse (côté serveur) |
| Coût | Faible | Gratuit/payant | Gratuit |

## Décision
**Option C**, avec deux garde-fous qui ne dépendent pas du défi.
- Le site du client affiche le widget Turnstile (clé de site) et envoie le jeton dans le corps : `turnstile_token`. Aucun en-tête nouveau : pas de changement CORS.
- Le **serveur** vérifie le jeton auprès de Cloudflare (`siteverify`, délai 3 s) avec la clé secrète de la plateforme (`TURNSTILE_SECRET_KEY`, serveur uniquement, jamais `NEXT_PUBLIC_*`). Il compare le nom d'hôte du défi à l'origine de la clé de formulaire. Seuls le secret, le jeton, l'adresse du visiteur et une clé d'idempotence sont envoyés.
- Déploiement progressif : `TURNSTILE_ENFORCE=false` (défaut) vérifie le jeton s'il est présent mais ne l'exige pas ; `true` l'exige (et demande la clé secrète au démarrage). Jeton refusé : 403 `forbidden` (un seul refus). Cloudflare injoignable : 503 si exigé (échec fermé).
- La vérification a lieu après le champ piège et juste avant l'écriture : un robot grossier n'appelle pas Cloudflare.
- **Plafond journalier par clé** (`capture_key_day`, 1000 par jour) : protège le quota même si le défi est contourné.
- **Réponse neutre** : quota « contacts » ou abonnement épuisé = le même 429 `rate_limited` + `Retry-After` que la limitation de débit.

## Conséquences
- Chaque site client doit intégrer le widget ; la clé de site est liée à des noms d'hôte déclarés chez Cloudflare (nombre limité par widget : créer les widgets par l'API Cloudflare si le nombre de clients le demande). Reste à décider avant l'exigence généralisée.
- Dépendance à la disponibilité de Cloudflare dès que le défi est exigé.
- Vie privée : le jeton et l'adresse du visiteur sont envoyés à Cloudflare ; à mentionner dans la politique de confidentialité des clients.
- Un attaquant disposant d'un vrai navigateur et de plusieurs adresses reste ralenti, pas arrêté : le plafond journalier et le seau par adresse limitent les dégâts.
- Retour arrière : `TURNSTILE_ENFORCE=false` ou clé secrète retirée ; aucune migration.
