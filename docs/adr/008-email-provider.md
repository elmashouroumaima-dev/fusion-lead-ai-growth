# ADR 008 — Fournisseur e-mail

- **Statut :** Accepted **sous réserve de Q2** (hypothèse §14 appliquée le 2026-11-11 : option A, Postmark ; Gmail non requis)
- **Date :** 2026-11-11
- **Section de spec :** §9.2, §11, §13-5, §14 Q2 ; fiche : `docs/integrations/email.md`

## Contexte
Le MVP exige un seul fournisseur e-mail (spec §5.5) capable d'envoyer au nom de l'entreprise, de remonter delivered/bounce/complaint, de recevoir les réponses, et d'authentifier ses webhooks. Q2 (Gmail vs fournisseur, propriétaire du domaine) n'a pas de réponse propre : on suit l'hypothèse §14.

## Options comparées
| Critère | A. Fournisseur transactionnel (candidat vérifié : Postmark) | B. Gmail OAuth | C. SMTP générique |
|---|---|---|---|
| Envoi | API | `gmail.send` (sensible) | SMTP |
| Statuts delivered/bounce/complaint | Webhooks documentés | Non (pas d'événement de délivrabilité) | Non |
| Réception | Inbound parse (forfait **à confirmer**) | Scope restreint + évaluation de sécurité | Non |
| Authentification des webhooks | **Pas de HMAC** ; Basic Auth + IP | n/a (OAuth) | n/a |
| Revue externe | Aucune | Vérification Google (sensible/restreinte) | Aucune |
| Charge DNS | SPF/DKIM par domaine | Boîte de l'utilisateur | SPF/DKIM |
| Conformité §9.2 | Oui | Partielle (pas de signaux de délivrabilité) | Non |

## Décision recommandée
**Option A** : fournisseur d'envoi transactionnel avec API, événements et réception entrante. **Postmark est le candidat à ce jour** parce que ses pages officielles sont vérifiées (événements, reprises, JSON entrant) ; ce n'est pas un choix définitif : Mailgun, SendGrid, Resend et Amazon SES **n'ont pas été vérifiés** dans des pages officielles (voir fiche) et doivent être comparés avant l'ouverture d'un compte. Critères de choix finaux : (1) réception entrante incluse au forfait, (2) méthode d'authentification des webhooks (signature préférée), (3) un domaine d'envoi par entreprise, (4) région/données (Q5), (5) coût.

Gmail (B) : hors MVP — l'envoi seul serait possible, mais recevoir exige un scope restreint et une évaluation de sécurité.

## Conséquences
- Adaptateur `packages/adapters/email` avec l'interface commune ; premier fournisseur implémenté derrière `send / receive / parseStatusEvent`; changer de fournisseur ne touche pas le domaine.
- Si le fournisseur retenu n'a pas de signature HMAC : Basic Auth par canal + jeton dans l'URL + liste d'IP + dédup, avec accord explicite de la responsable technique (signalé dans la fiche).
- Tenant résolu via `provider_message_id` dans nos tables et l'adresse de réponse par canal (jamais un champ libre).
- Décision finale et ouverture du compte sandbox avant le **J31**.

## Note (2026-11-07) — Paramètres SMTP de la plateforme
Une configuration SMTP générique (option C) est désormais saisissable dans Paramétrage par les administrateurs de la plateforme (boîte de test Mailtrap comprise) : elle sert aux e-mails de la plateforme et aux tests, mais **ne remplace pas** la décision de cet ADR pour l'envoi de campagnes (option A : API avec événements, réception, webhooks). Voir `docs/runbooks/smtp-settings.md`.

## Décision du 2026-11-09
L'ADR reste **Proposed** : le choix du fournisseur dépend de Q2 (propriétaire du domaine, Gmail ou fournisseur transactionnel), toujours sans réponse, et aucune des alternatives à Postmark n'a été vérifiée. **À trancher au plus tard au début du J31** (compte sandbox ouvert) ; sans réponse à Q2, appliquer l'hypothèse §14 (option A, Postmark) et le noter ici.

## Décision du 2026-11-11 (J31)
Q2 n'a toujours pas de réponse : en application de la règle du 2026-11-09, l'**hypothèse §14 est retenue** (option A, Postmark) et l'adaptateur `packages/adapters/src/email/postmark.ts` l'implémente derrière l'interface `EmailProvider` (changer de fournisseur ne touche ni le domaine ni le worker). **Aucun compte n'est ouvert et aucun envoi réel n'est fait** avant le checkpoint C3 ; le comportement du fournisseur (codes d'erreur, forfait de réception, limites, sandbox) reste **À CONFIRMER** sur un compte réel (`docs/integrations/email.md`). Si la réponse à Q2 change le fournisseur, seul l'adaptateur est à remplacer. Voir `docs/api/send.md`.

## Note du 2026-11-12 (J32) — authentification des webhooks, entrants
- **Basic Auth acté** par la responsable technique (plan J32 validé le 2026-11-12) : pas de HMAC chez Postmark ; l'utilisateur est l'identifiant du compte de l'intégration, le mot de passe est un **secret de webhook propre à chaque intégration**, distinct du jeton d'envoi (jamais égal : contrôlé à l'enregistrement). HTTPS exigé en production ; pas de liste d'adresses IP (elles changent). Écart accepté : le secret circule à chaque requête.
- **Rattachement des réponses** : par l'adresse expéditrice dans le canal désigné par l'adresse destinataire (un fil par contact et canal, J30), pas par `Message-ID` / `In-Reply-To` / `References`. **Anti-usurpation** : le « Pass » SPF doit être aligné sur le domaine de l'adresse « From » (ou DKIM valide du domaine de l'auteur) ; en-têtes dupliqués = non fiable ; sinon file `inbound_unmatched`.
- **Rebonds et plaintes** : rebond dur (TypeCode 1 ou 100000) : adresse en `suppressions` sans toucher `do_not_contact` ; plainte : `suppressions` et `do_not_contact = true`.
- Tout reste **À CONFIRMER sur un compte sandbox** (checkpoint C3) : en-têtes réellement ajoutés aux entrants, `Metadata` renvoyées dans les événements, codes de rebond. Voir `docs/api/email-inbound.md` et `docs/runbooks/email-webhooks.md`.
