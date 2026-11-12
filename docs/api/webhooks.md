# Webhooks entrants (J29)

Migration `20261129100000_webhook_events.sql` (retour arrière : `supabase/rollbacks/20261129100000_webhook_events.sql`). Spec §8 et §11, ADR 005 (décisions 8 et 9), ADR 007 (`webhook_events`), menaces C1 à C5 (`docs/security/threat-model.md`). Route : `POST /api/webhooks/[provider]`.

## Principe
Un webhook n'a **pas de session**. Le fournisseur est dans l'adresse, l'entreprise est retrouvée par l'identité du **compte fournisseur** (`integrations (provider, external_account_id)`, unicité globale des comptes `email` et `whatsapp`, J28), jamais par un champ libre du payload ; l'authenticité vient de la **signature sur le corps brut**. L'événement est enregistré puis **traité plus tard** par le worker : la réponse est rapide.

## Pipeline (`packages/adapters/src/webhooks/ingest.ts`, fonction pure)
1. Fournisseur sans adaptateur enregistré : **404** (WhatsApp : J34 et J35 ; l'**e-mail** a un adaptateur depuis le J32, `docs/api/email-inbound.md`).
2. Adresse source obligatoire (`TRUSTED_PROXY_HOPS`) : sinon **503** visible (jamais un seau de débit commun à tous les appelants) ; limitation de débit par fournisseur et par adresse (IPv6 agrégée par /64) : **429** + `Retry-After`.
3. Corps brut lu avec un plafond (`maxBytes` de l'adaptateur, 3 Mo pour WhatsApp) : **413**.
4. JSON lisible, compte présent : sinon **400**.
5. Entreprise résolue par le **compte**. Compte inconnu, désactivé ou déconnecté : **le même 401 qu'une signature invalide**, après une vérification factice (même travail, même réponse : aucun oracle d'existence d'un compte, revue J29), sans aucune écriture.
6. Secret de l'intégration (absent : refus) puis **signature** HMAC sur le corps brut, comparaison à temps constant. Échec : **401** et une ligne `rejected` **sans payload ni identifiant** (plafonnée à 200 par intégration et par heure).
7. Horodatage signé (si l'adaptateur en déclare un) : un nombre fini dans les 5 minutes, sinon le même 401.
8. Identifiant d'événement présent ; **enregistrement idempotent** (`unique (organization_id, provider, external_event_id)`) : un rejeu répond **200 `duplicate`**, sans second traitement ; sinon **200 `accepted`**.
Un adaptateur qui lève une exception donne une requête invalide ou un refus, jamais une erreur serveur.

## Base
- **`webhook_events`** : `organization_id`, `integration_id` (clé composite), `provider`, `external_event_id`, `received_at`, `processed_at`, `status` (`received`, `processed`, `ignored`, `failed`, `rejected`), `payload jsonb` (4 Mo au plus), `signature_valid`, `failure_code`. Un `rejected` n'a ni payload ni identifiant.
- Lecture API : owner et admin, **métadonnées seulement** (SELECT par colonnes : le payload peut contenir des données personnelles et n'est lisible par aucun rôle d'API ; `select *` est refusé). Aucune écriture directe, même service_role.
- Fonctions **service_role seulement** : `webhook_resolve_integration`, `webhook_record` (événement + job `process_webhook` dans la **même transaction** ; plafond de 10 000 événements `received` des 7 derniers jours par entreprise, au-delà `too_many_webhooks` = 503), `webhook_record_rejection`, `webhook_start`, `webhook_finish`.

## Worker (`process_webhook`)
Le handler lit l'événement avec l'entreprise de la **ligne du job**, le confie au processeur du fournisseur (`WebhookProcessors`, vide aujourd'hui) et le termine en `processed` ou `ignored`. Sans processeur : `failed` avec le code `no_processor` (visible et **re-jouable**, le payload reste en base). Un événement terminé, inconnu ou d'une autre entreprise est ignoré (rejeu du job sans effet). Échec définitif : `failed` + code ; reprise selon la politique des jobs.

## Contrat d'un adaptateur (e-mail J32, WhatsApp J34)
`parse`, `extractAccount`, `extractEventId`, `extractTimestamp?`, `verify`, `maxBytes`. **L'identifiant d'événement doit être tiré de contenu COUVERT par la signature** (jamais d'un en-tête non signé), sinon changer l'en-tête d'une capture valide contournerait la déduplication. Helper `verifyHmacSha256Hex` fourni (WhatsApp : `X-Hub-Signature-256`).

## Limites connues et décisions à prendre (revue J29)
- **Quel secret signe ? (résolu au J32)** Le secret de WEBHOOK est un **second emplacement** par intégration (`webhook_secret_ref`, `docs/api/email-inbound.md`), distinct du jeton d'envoi ; la route lit celui-là. (Texte du J29 :) Le secret de l'intégration (J28) n'a qu'un emplacement. Pour WhatsApp la clé HMAC est le *App Secret*, pas le jeton d'accès. Avant le J34 : un secret de webhook **distinct et propre à chaque entreprise** (un App Secret partagé entre entreprises permettrait à l'une de signer un événement visant le compte d'une autre).
- **Événements bloqués en `received`** si un job meurt (dead letter) : la fenêtre de 7 jours du plafond limite l'effet ; un balayage et le rejeu des dead letters arrivent avec l'exploitation (J39).
- **Rétention** : le payload (données personnelles) et les lignes `rejected` ne sont pas purgés ; une purge ne doit pas rouvrir une fenêtre de rejeu (J39, J58). Un effacement d'entreprise devra supprimer ses `webhook_events`.
- **Pas de limite par intégration** après résolution (seulement par adresse) ; les lignes `rejected` sont plafonnées mais un inconnu qui vise un compte connu peut masquer pendant une heure les vrais rejets de ce compte.
- Déduplication par entreprise et fournisseur (pas par intégration) : deux numéros d'une même entreprise qui réutiliseraient des identifiants d'événement identiques se dédupliqueraient.
