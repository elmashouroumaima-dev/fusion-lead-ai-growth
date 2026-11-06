# Intégration — E-mail

- **Spec :** §9.2, §8, §11, §13-5, §14 Q2, §15
- **Consultée le :** 2026-11-05. Marqué **À CONFIRMER** ce qui n'a pas pu être vérifié dans une page officielle.
- **Décision de fournisseur :** ADR 008 (conditionnée à Q2). Hypothèse §14 : **un seul fournisseur** au MVP.

## Exigences de la spec (non négociables)
Consentement adapté à la finalité · lien de désabonnement · identité d'expéditeur claire · contrôle `do_not_contact` et rebonds · limites de débit par entreprise · `delivered` seulement sur événement fournisseur (jamais sur l'acceptation de l'API) · entrants rattachés par identifiants fournisseur et en-têtes, avec plan pour les cas ambigus · jetons chiffrés via `secret_ref`.

## Option A — Fournisseur d'envoi transactionnel (API + webhooks + réception)
Candidat vérifié : **Postmark** (docs officielles consultées).
- **Événements sortants** : delivery, bounce, spam complaint, open, click, subscription change ; l'inbound utilise une infrastructure de webhook séparée. Source : https://postmarkapp.com/developer/webhooks/webhooks-overview
- **Authentification des webhooks** : **pas de signature HMAC** (« Postmark does not currently support HMAC webhook signature verification »). Moyens documentés : **HTTP Basic Auth** dans l'URL (HTTPS obligatoire) et **liste d'IP autorisées** (les IP peuvent changer d'une tentative à l'autre). En-têtes `X-PM-Retries-Remaining` et `X-PM-Webhook-Trace-Id` pour suivre les reprises/idempotence. → **Mesure compensatoire** : identifiants Basic Auth propres à chaque canal + chemin d'URL avec jeton aléatoire + liste d'IP + dédup par `X-PM-Webhook-Trace-Id`/`MessageID`. La spec exige « signature/secret correct » (§11) : un secret en Basic Auth satisfait « secret » mais est plus faible qu'une signature → à acter par la responsable technique.
- **Reprises sortantes** : 5xx, 408, 429, erreurs réseau → 6 tentatives (1, 5, 10, 10, 10, 15 min) ; autres 4xx : événement abandonné ; désactivation du type d'événement après 48 h d'échec complet. Même source.
- **Entrant** : JSON avec `MessageID`, `Headers` (tableau Name/Value contenant `Message-ID`, et `In-Reply-To`/`References` s'ils existent), `MailboxHash` (partie après `+` dans l'adresse), `From`, `Subject`, `TextBody`/`HtmlBody` ; reprises : jusqu'à 10 sur 1 min → 6 h, un 403 arrête les reprises ; 2 min de délai de réponse. Source : https://postmarkapp.com/developer/user-guide/inbound/parse-an-email. **Disponibilité de l'inbound selon le forfait : non indiquée → À CONFIRMER.**
- **Limites de débit / plafonds** : **À CONFIRMER**.
- **Compte de test** : un compte sandbox est à créer ; domaine d'envoi + SPF/DKIM/DMARC (Q2) : **À CONFIRMER**.

Autres fournisseurs de même famille (Mailgun, SendGrid, Resend, Amazon SES) : non vérifiés dans des pages officielles lors de cette session (seules des comparaisons tierces ont été vues) → **À CONFIRMER** avant toute comparaison finale. *Note : la page de documentation des webhooks Mailgun testée a renvoyé une erreur 404 ; ne pas en conclure quoi que ce soit.*

## Option B — Gmail / Google Workspace (OAuth)
Source : https://developers.google.com/workspace/gmail/api/auth/scopes
- `gmail.send` : classé **sensible** (vérification OAuth supplémentaire).
- Lecture/réception : `gmail.readonly`, `gmail.modify`, `gmail.compose`, `gmail.metadata` : classés **restreints** → vérification de scopes restreints, avec **évaluation de sécurité requise** si des données restreintes sont stockées/transmises par des serveurs.
- La doc recommande le **scope le plus étroit** et les scopes non sensibles quand c'est possible.
- Conséquence : l'envoi seul (`gmail.send`) est faisable avec vérification « sensible » ; **recevoir** les réponses dans l'inbox impose un scope restreint et donc une revue lourde, incompatible avec un calendrier MVP si le domaine/boîte est celui de chaque client. Les jetons OAuth iraient dans `secret_ref` et seraient rafraîchis côté serveur.

## Option C — SMTP générique
Envoi possible sans API mais sans événements fiables (delivered/bounce) ni réception → ne satisfait pas §9.2 sans composants supplémentaires. Non retenue.

## Modèle multi-entreprise (à trancher avec Q2)
Chaque entreprise doit avoir **sa propre identité d'expéditeur** (spec §9.2 : « بتفويض الشركة »). Conséquences :
- Vérification du domaine d'envoi par entreprise (SPF/DKIM) ; pour l'entreprise Fusion Leap, le propriétaire du domaine doit être identifié (Q2).
- **Résolution du tenant** des événements fournisseur : par recherche du `provider_message_id` dans **nos** `messages` (donnée que nous avons écrite), jamais par un champ libre du payload ; pour les entrants, par l'adresse de réponse propre au canal (alias `reply+<jeton>@…` / `MailboxHash`) présente dans `channels`.
- Un compte fournisseur partagé par plusieurs entreprises (et non un compte par entreprise) est possible mais exige ces mappages ; décision en ADR 008.

## Désabonnement et suppression (J33)
`List-Unsubscribe` et `List-Unsubscribe-Post`, jeton HMAC (organisation + contact + canal), page publique AR/EN, `revokeConsent()`, annulation des jobs. Les rebonds durs et plaintes alimentent `suppressions`.

## Plan B
Fournisseur transactionnel en mode sandbox sans domaine propre pour les tests ; envoi réel au checkpoint C3. Gmail : hors MVP (backlog).

## Tests liés
Fixtures officielles : delivery, bounce, spam complaint, entrant avec/sans `In-Reply-To`, entrant ambigu ; reprise 5xx ; webhook dupliqué ; authentification invalide.
