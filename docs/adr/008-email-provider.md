# ADR 008 — Fournisseur e-mail

- **Statut :** Proposed — **dépend de Q2** (hypothèse §14 : un fournisseur, Gmail non requis)
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

