# Intégration — WhatsApp Business Platform (Cloud API)

- **Spec :** §9.3, §8 (webhooks), §11, §13-6, §14 Q3, §15
- **Consultée le :** 2026-11-05 (pages Meta citées ci-dessous). Ce qui n'a pas pu être vérifié est marqué **À CONFIRMER**.
- **Règle absolue :** Cloud API officielle uniquement, jamais WhatsApp Web (spec §9.3).

## Authentification et comptes
- Les requêtes utilisent un **jeton d'accès** envoyé en `Authorization: Bearer` vers la Graph API ; les permissions limitent l'accès à des ressources précises. Source : https://developers.facebook.com/docs/whatsapp/cloud-api/
- Le démarrage Cloud API crée automatiquement un **compte WhatsApp de test, un compte de messagerie de test et un numéro de test**, avec limites assouplies et **sans moyen de paiement** pour envoyer des templates. Même source.
- Modèle par entreprise (Q3) : chaque entreprise connecte **son** compte/numéro ou une autorisation à elle (spec §9.3). *Variante « numéro géré par Fusion Leap » : non retenue par l'hypothèse §14 ; elle imposerait un compte partagé, un routage par numéro et la facturation Meta (voir `gaps-and-questions.md` Q3).*
- **Stockage des jetons** : via `secret_ref` (ADR 004), jamais en clair. Durée de vie, jetons système vs temporaires, rotation : **À CONFIRMER** (non précisé dans les pages consultées).
- **Version d'API** : les exemples de la doc utilisent v17.0 ; la politique de versions n'est pas décrite dans la page consultée. La version cible sera figée et citée au **J34**. **À CONFIRMER.**

## Webhooks
- **Vérification de l'endpoint (GET)** : Meta appelle l'URL avec `hub.mode=subscribe`, `hub.challenge`, `hub.verify_token` ; l'endpoint compare `hub.verify_token` à la valeur configurée et renvoie `hub.challenge`. Source : https://developers.facebook.com/docs/graph-api/webhooks/getting-started
- **Signature (POST)** : en-tête `X-Hub-Signature-256` de la forme `sha256=…`, calculé à partir du corps avec l'**App Secret** (même source ; la doc dit que la validation est « optionnelle » — **elle est obligatoire chez nous**, invariant 9). L'algorithme HMAC-SHA256 est le schéma usuel ; la page ne le nomme pas : **À CONFIRMER** au J34 avec la fixture officielle. Calcul sur le **corps brut** (pas sur le JSON re-sérialisé).
- **Champs / événements** : le champ `messages` couvre les messages entrants **et** les statuts des messages envoyés ; d'autres champs existent (`message_template_status_update`, `message_template_quality_update`, `phone_number_quality_update`, `account_update`, `account_alerts`…). Abonnement dans le tableau de bord de l'app. Source : https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks
- **Reprises (retries)** : tout statut ≠ 200 déclenche des reprises à fréquence décroissante **jusqu'à 7 jours** ; des notifications en double sont possibles → **déduplication obligatoire** (`external_message_id` / `external_event_id`). Même source.
- **Taille** : jusqu'à 3 Mo (même source) → limite de taille de notre route à 3 Mo.
- **Mode de l'app** : certains webhooks ne sont pas envoyés tant que l'app est en mode développement ; l'app doit être en mode **Live** (même source). Conditions de passage en Live (vérification d'entreprise ?) : **À CONFIRMER** — risque pour le J34.
- **Tenant** : résolu par l'identifiant du compte WhatsApp Business (`entry[].id` / identifiant du numéro) cherché dans `integrations (provider='whatsapp', external_account_id)` — jamais par un champ libre. Champ exact à confirmer sur la fixture officielle (**À CONFIRMER**, J34).

## Limites de débit et de messagerie
- Par défaut **200 requêtes/heure** par compte de messagerie sur les endpoints listés ; **5 000/heure** pour un compte de messagerie actif avec au moins un numéro enregistré. Source : https://developers.facebook.com/docs/whatsapp/cloud-api/
- **80 messages/seconde** par numéro par défaut ; limite de paire : 1 message toutes les 6 secondes vers le même utilisateur (code d'erreur **131056**). Même source.
- **Limites de messagerie** (utilisateurs uniques contactables hors fenêtre sur 24 h glissantes), définies au niveau du portefeuille d'entreprise. Même source.
- Notre limiteur (J39) : token bucket par (provider, organisation) en dessous de ces plafonds ; erreur 131056 et erreurs de limite traitées comme réessayables avec backoff.

## Fenêtre de conversation et templates (spec §9.3)
- Les **templates sont le seul type de message envoyable hors fenêtre de service client** ; seul le statut `APPROVED` est envoyable ; les templates rejetés, paused, disabled ne le sont pas. Catégories : authentication, marketing, utility. Source : https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview
- **Durée de la fenêtre** (24 h après le dernier message de l'utilisateur ?) : **non confirmée** par les pages consultées. **À CONFIRMER** avant le J36 ; `assertCanSend` la calcule depuis le dernier message entrant avec une constante configurable.
- Code d'erreur d'un envoi libre hors fenêtre : **À CONFIRMER** (J36, fixture).
- Template enregistré sur le message : `template_id`, `version`, `language` (spec §9.3) ; synchronisation de statut via `message_template_status_update`.

## Consentement et conformité
- Aucun envoi initié sans consentement valide pour la finalité et le canal, sans `do_not_contact` à faux, et sans template approuvé hors fenêtre.
- Toute demande d'arrêt reçue (ex. « STOP ») met à jour `consent_events` + `do_not_contact` immédiatement et annule les jobs en attente.
- Politique commerciale/messagerie de Meta : à relire à la date de lancement (spec §15) — **À CONFIRMER**.

## Médias
Les entrants stockent la référence ; téléchargement différé vers Storage privé (J35).

## Comptes à créer et responsabilités
| Élément | Qui | Quand |
|---|---|---|
| Compte développeur Meta + app + WhatsApp Business Account + numéro de test | Responsable technique | **Avant le J34** (demande dès J0–J2) |
| App Secret, verify token, jeton d'accès | Responsable technique → saisis dans l'UI (écriture seule) | J34 |
| URL publique HTTPS du webhook (staging/tunnel) | Responsable technique | J34 |

## Plan B
1. Adaptateur développé contre les **fixtures officielles + MSW** (J34–J36) ; test réel déplacé au J41 puis à la recette (J60–J62).
2. Si l'app ne peut pas passer en Live : tests via le numéro de test et déclenchement manuel des webhooks avec payloads copiés de la doc.
3. Si aucun accès Meta n'est disponible avant G3 : G3 est déclarée « partielle » pour WhatsApp, avec NO-GO explicite sur le critère §13-6 réel.

## Tests liés
Fixture par type d'événement (message entrant texte, statut sent/delivered/read/failed, template status update) ; webhook dupliqué ; statuts hors ordre ; signature invalide ; payload > 3 Mo.
