# Envoi d'e-mail derrière la chaîne de contrôles (J31)

Migration `20261201100000_send_chain.sql` (retour arrière : `supabase/rollbacks/20261201100000_send_chain.sql`). Spec §5.7, §9.2, figure 9 ; ADR 007 (G-D5), ADR 008 ; menaces B3 et C3. **Aucune route HTTP n'envoie** : l'envoi se fait dans le worker (job `send_message`). Pas d'écran (inbox J37, approbation en interface J38 et J44).

## Principe
Un message sortant naît `queued` (J30). Un humain habilité l'**approuve** pour UNE finalité ; l'approbation met le job `send_message` en file dans la même transaction. Le worker **relit tout l'état**, applique la chaîne de contrôles **juste avant l'appel**, appelle le fournisseur, puis enregistre `accepted` et l'identifiant du fournisseur. `accepted` n'est pas `delivered` : `delivered` ne vient que d'un événement du fournisseur (J32).

## Base de données
- **`messages`** : `approved_by`, `approved_at`, `approved_purpose`, `approved_recipient` (adresse du contact **figée à l'approbation**), `send_claimed_at` (une seule tentative d'appel). Les colonnes d'approbation ne s'écrivent que par `message_approve` et ne changent plus ; `approved_by` n'a pas de clé étrangère vers l'adhésion (fait d'audit : supprimer un compte n'est pas bloqué).
- **Garde-fous de base** : un message ne passe pas à `accepted`, `sent`, `delivered` ou `read` sans approbation ; les statuts ne reculent pas (`queued` > `accepted` > `sent` > `delivered` > `read` ; `failed`, `bounced`, `cancelled` terminaux) ; seule exception : `failed` avec le code `send_outcome_unknown` peut devenir `accepted` (le fournisseur avait bien accepté).
- **`suppressions`** (ADR 007 G-D5) : `channel`, `value_normalized`, `reason` (`bounce`, `complaint`, `unsubscribe`, `manual`), `source_message_id`, unique `(organization_id, channel, value_normalized)`. Lecture owner, admin, marketing ; **aucune écriture** aujourd'hui (J32 et J33).

## Fonctions SQL
| Fonction | Rôle | Effet |
|---|---|---|
| `message_approve(p_org, p_message, p_purpose)` | owner, admin (jamais service_role) | approuve un message sortant `queued` pour une finalité, fige l'adresse du contact, trace `approved_by = auth.uid()`, met le job `send_message` en file (clé `send-message:<id>`, charge utile : l'identifiant du message seulement) ; audit `message.approved` |
| `message_send_claim(p_org, p_message)` | **service_role** | relit l'état dans une transaction verrouillée et pose la tentative. Statuts : `missing`, `not_queued`, `in_progress` (tentative de moins de 5 minutes), `ambiguous` (plus ancienne), `claimed` (avec corps, destinataire, canal, consentement, suppression, pause, approbation revalidée, débit) |
| `message_mark_accepted(p_org, p_message, p_provider_message_id)` | **service_role** | `queued` (ou `failed` / `send_outcome_unknown`) vers `accepted` ; audit `message.accepted` |
| `message_mark_failed(p_org, p_message, p_code)` | **service_role** | `queued` vers `failed` avec un code court |
| `message_release_claim(p_org, p_message)` | **service_role** | le fournisseur a répondu « non accepté » : un nouvel essai est permis |
Codes : `42501` interdit · `22023` valeur invalide · `PT404` introuvable · `P0001 message_not_approvable`.

## Chaîne de contrôles (`packages/domain/src/outbound`)
`checkCanSend` est pure et échoue fermé. Premier refus gagnant, dans cet ordre : `not_approved`, `approval_invalid` (l'approbateur n'est plus owner ou admin actif), `approval_stale` (plus de 72 h), `no_purpose`, `organization_inactive` (entreprise suspendue ou abonnement suspendu / annulé), `organization_paused`, `channel_paused`, `channel_inactive`, `no_recipient`, `recipient_changed` (adresse modifiée depuis l'approbation), `do_not_contact`, `suppressed`, `no_consent` (consentement actif pour ce canal ET cette finalité), `template_missing` (WhatsApp, J36), `rate_limited`. Un refus est **définitif** (message `failed`, code `refused_<raison>`) sauf `rate_limited` (tentative libérée, job rejoué). Limite provisoire : **100 e-mails par heure et par canal** (`EMAIL_SENDS_PER_HOUR`), en attendant le limiteur du J39.

## Adaptateur e-mail (`packages/adapters/src/email`)
Interface `EmailProvider.send(input, secret)` ; premier fournisseur : Postmark (ADR 008). URL fixe, jeton dans l'en-tête, délai 15 s, réponse lue sur 64 Ko, aucun texte du fournisseur recopié. Résultats : `accepted` (identifiant du fournisseur) · `rejected` (définitif : `provider_auth`, `recipient_inactive`, `recipient_invalid`, `provider_rejected`, `invalid_input`) · `retryable` (réponse « non accepté » : 429, 500, 503) · `unknown` (aucune réponse exploitable, 200 illisible, 502, 504 et autres 5xx de passerelle : le message est PEUT-ÊTRE parti, **jamais renvoyé**). Tests avec un `fetch` injecté (MSW n'est pas installé : écart signalé).

## Worker : `send_message`
Charge utile stricte `{ message_id }`. Entreprise = celle de la ligne du job. Ordre : `claim` > `checkCanSend` > lecture du jeton (`secret_ref`, déchiffré en mémoire) > appel > résultat. **Au plus un envoi par message** : tentative sans résultat connu = `failed` / `send_outcome_unknown` (jamais renvoyé automatiquement) ; l'acceptation se réenregistre 3 fois sur panne brève de la base. Aucun corps, adresse ni jeton dans les journaux, l'audit ou les codes.

## Audit
`message.approved`, `message.accepted`, `message.failed` : identifiants, finalité et codes. Jamais le corps, l'adresse, l'identifiant du fournisseur ni la clé d'envoi.

## Limites connues et décisions à confirmer
- **Postmark est une hypothèse** (ADR 008 ; Q2 sans réponse) : aucun compte ouvert, aucun envoi réel avant le checkpoint C3.
- **Aucun flux n'active un canal ou une intégration e-mail** (validation des identifiants auprès du fournisseur) : la chaîne exige les deux « actifs », donc le premier envoi réel attend ce flux (J32).
- **Pas de lien de désabonnement ni de pied de message** : aucun envoi marketing réel avant le J33 (`List-Unsubscribe`).
- **Objet de l'e-mail** : première ligne du corps (120 caractères au plus), en attendant les modèles du J40 (pas de colonne `subject`).
- **Pas de quota `messages_per_month`** consommé à l'envoi (J39) ; la limite de débit horaire est provisoire.
- Un message `failed` / `send_outcome_unknown` peut avoir été livré : le J32 doit rapprocher l'événement du fournisseur (l'identifiant du fournisseur manque) et peut le passer à `accepted`.
- Un message approuvé dont le job est annulé reste `queued` sans retour possible : fonction d'annulation à prévoir (J38).
- Les lecteurs d'une conversation voient les colonnes d'approbation (`approved_by`, `approved_purpose`, `send_claimed_at`) : acceptable, à revoir si un rôle ne doit pas les voir.
- Le consentement n'a pas d'expiration ; la finalité approuvée est une chaîne libre (liste de finalités à fixer avec le J30b).
- Le contrôle final se fait après la relecture et avant l'appel : l'écart est un aller-retour base (lecture du jeton), et une révocation de consentement dans cette fenêtre de quelques millisecondes n'est pas vue.
