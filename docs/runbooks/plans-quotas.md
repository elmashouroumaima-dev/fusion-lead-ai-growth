# Plans, quotas et administrateurs de la plateforme

## Principe
- **Plans** (`public.plans`) : catalogue global, limites en `jsonb` (`users`, `projects`, `contacts`, `messages_per_month`, `ai_runs`, `integrations`). Valeurs **provisoires** (la spec n'en donne aucune, à valider par la responsable technique) :

| Plan | users | projects | contacts | messages/mois | runs IA/mois | intégrations |
|---|---|---|---|---|---|---|
| trial | 3 | 1 | 500 | 200 | 50 | 2 |
| starter | 5 | 3 | 5 000 | 2 000 | 200 | 3 |
| growth | 15 | 10 | 50 000 | 20 000 | 2 000 | 6 |

- **Abonnement** (`public.subscriptions`) : un par organisation ; `limits_override` (même forme) l'emporte sur le plan ; une clé absente partout = **pas de limite** pour cette métrique ; `0` bloque la métrique.
- **Métriques de flux** (`messages_per_month`, `ai_runs`) : compteur mensuel (UTC) dans `usage_counters`, incrément **atomique** par un UPDATE conditionnel (jamais de dépassement sous concurrence).
- **Métriques de stock** (`users`, `projects`, `contacts`, `integrations`) : usage = lignes existantes. `users` = membres actifs + invitations en attente non expirées. Les trois autres valent 0 tant que leurs tables n'existent pas (J16 et suivants) : leur module doit redéfinir `private.current_stock_usage`.
- **Contrôle** : `private.assert_within_limit(org, métrique, quantité)` renvoie `{metric, used, limit, remaining, near_limit}` (alerte à 80 %) ou lève `quota_exceeded` (SQLSTATE `P0001`, detail = métrique) ; abonnement suspendu, annulé ou absent : `subscription_inactive`. Côté application, l'erreur devient `quota_exceeded` (HTTP 429, message traduit).
- **Invitations** : `create_invitation` contrôle la limite `users` dans la même transaction (après la révocation de l'ancienne invitation de la même adresse) ; un refus annule tout.

## Qui peut quoi
| Action | Qui | Fonction |
|---|---|---|
| Consommer une métrique de flux (envoi, run IA) | serveur / worker (`service_role`) | `consume_quota(org, métrique, quantité)` |
| Lire l'usage de l'organisation | owner / admin actif | `get_org_usage(org)` |
| Lister les organisations, changer plan / statut / limites | administrateur de la plateforme | `admin_list_organizations`, `admin_set_subscription` |
| Écrire directement `subscriptions` et `plans` | personne (aucun droit d'API, même `service_role`) | — |
| Écrire `usage_counters` | fonctions de quota ; `service_role` (outillage, tests) | — |

Chaque changement d'abonnement est audité (`subscription.changed`, avant/après, motif, acteur = administrateur).

## Administrateurs de la plateforme
Table `private.platform_admins` : **aucun droit d'API**, gérée uniquement par SQL (opérations), jamais par l'application :
```sql
insert into private.platform_admins (user_id) values ('<uuid auth.users>');
delete from private.platform_admins where user_id = '<uuid>';
```
En local, `shared@seed.test` est administrateur (seed). L'écran est `/{locale}/admin/organizations` (lien « Administration » dans le menu, visible seulement pour eux).

Le rôle Platform Admin n'ouvre **aucun accès aux données d'une organisation** (ADR 005 §10 : sessions de support, hors périmètre J14) : il ne voit que le nom, le slug, le plan, l'abonnement et le nombre de membres actifs.

## Écrire un module soumis à quota (exemple)
```sql
-- avant d'envoyer un message (dans la transaction qui l'enregistre)
select private.assert_within_limit(p_org, 'messages_per_month', 1);
```
Depuis le worker : `rpc("consume_quota", { p_org, p_metric: "messages_per_month", p_amount: 1 })`. Une erreur `quota_exceeded` est **définitive pour ce mois** : lever `NonRetryableError("quota_exceeded")` dans le handler.

## Limites connues
- Valeurs de plans provisoires ; pas de quota global ni d'équité entre organisations ; pas de période d'essai qui expire automatiquement (`period_end` n'est pas encore appliqué).
- L'édition du catalogue `plans` se fait par migration ou SQL (pas d'écran).
- Un compteur de flux n'est pas décrémenté si l'opération échoue après la consommation : la consommation doit se faire dans la même transaction que l'action métier.
- Les palettes et le logo restent modifiables par tout owner/admin d'organisation (ADR 016) ; leur passage au Platform Admin est une décision séparée.
