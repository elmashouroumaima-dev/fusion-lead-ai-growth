# Envoi WhatsApp conforme (J36)

Migration `20261206100000_whatsapp_send.sql` (retour arrière : `supabase/rollbacks/20261206100000_whatsapp_send.sql`, qui recrée les fonctions J31 / J35 avant de supprimer les colonnes). Spec §9.3 et §13-6, ADR 007 (E5), plan J36. Aucun compte Meta réel : fixtures (test réel à C3). L'envoi passe par **la même chaîne** que l'e-mail (J31) : approbation humaine, réclamation, contrôle final dans le worker, un seul appel au fournisseur.

## Modèles de message (`message_templates`, ADR 007 E5)
- Colonnes : `channel_id`, `name`, `version`, `language`, `category` (`marketing`, `utility`, `authentication`), `status` (`pending`, `approved`, `rejected`, `paused`), `components` (jsonb ≤ 16 Ko) ; unique `(organization_id, channel_id, name, language, version)`. RLS : lecture owner, admin et marketing ; **aucune écriture directe** (même pas service_role).
- **Synchronisation** : `message_templates_sync(p_org, p_channel, p_items)` (service_role), 200 éléments au plus. Une nouvelle **version** naît quand les composants changent (l'ancienne reste, historique) ; sinon seuls la catégorie et le statut sont mis à jour. Plafond : 2000 lignes par canal, 1000 versions par modèle. Verrou par canal.
- **Route** `POST /api/integrations/templates/sync` `{ integration_id, channel_id, waba_id }` (owner et admin, `Idempotency-Key`, limite « sensible ») : le serveur relit l'intégration et le canal avec le client de l'utilisateur (RLS), déchiffre le jeton en mémoire, demande la liste à Meta (`GET /{waba_id}/message_templates`, adresse fixe) et écrit par la fonction. Jeton ou compte refusé : 400 ; panne de Meta : 503 sans rien écrire. Réponse `{ inserted, updated, unchanged, skipped }`. Statuts de Meta ramenés à 4 valeurs (en attente / en appel → `pending`, désactivé / signalé → `paused`).

## Rattacher un modèle (`message_attach_template`, owner et admin)
Avant l'approbation, sur un message sortant en file non réclamé : le modèle doit appartenir **au canal du message** et être `approved` ; les variables (10 au plus, 1 à 1024 caractères, **sans caractère de contrôle** : Meta refuse les retours à la ligne) sont enregistrées avec le modèle ; le **texte rendu** (corps du modèle + variables) est enregistré dans `messages.template_text` : c'est ce que l'approbateur relit et ce que le destinataire recevra. Modèle, variables et texte rendu sont **immuables dès l'approbation** (`messages_guard`). Audit : identifiant, nom, langue et version du modèle, jamais les variables.

## Approbation et réclamation
- `message_approve` : l'adresse approuvée est l'e-mail pour un canal e-mail, le **numéro (E.164)** pour un canal WhatsApp (contact sans numéro : non approuvable). Pour l'e-mail, comportement inchangé.
- `message_send_claim` relit en plus : le numéro du contact, le **compte du fournisseur** (`phone_number_id` de l'intégration), la **fenêtre de conversation** (un message du contact reçu il y a moins de 24 h dans ce fil) et le modèle (statut, nom, langue, version, variables, texte rendu). Un modèle remplacé par une **version plus récente** est vu `superseded` : ce qui partirait est la dernière version chez Meta, pas celle que l'approbateur a relue.
- Suppressions et consentement : par numéro pour WhatsApp (`suppressions.value_normalized`), consentement du canal `whatsapp`.

## Worker (contrôle final puis envoi)
`checkCanSend` (15 contrôles) pour WhatsApp aussi : hors fenêtre, ou si un modèle est rattaché, un modèle **approuvé** est obligatoire (`template_missing`) ; limite provisoire de 100 envois par heure et par canal (`WHATSAPP_SENDS_PER_HOUR`). Puis, selon le cas : **modèle** (nom, langue, variables en composants du corps) ou **texte libre** (dans la fenêtre, sans modèle) vers `POST /{phone_number_id}/messages` (adresse fixe, destinataire en chiffres sans `+`).
- Résultats : `accepted` (identifiant `wamid`, jamais « livré » : `delivered` vient des statuts, J35), `rejected` (jeton, fenêtre fermée 131047, destinataire invalide, modèle invalide), `retryable` **seulement** pour les limites de débit sans ambiguïté (429, codes 4, 17, 32, 613, 80007, 130429, 131056), `unknown` pour toute erreur 5xx, les erreurs internes 1 et 2, une coupure ou un 200 illisible : **jamais renvoyé à l'aveugle** (`send_outcome_unknown`).
- Un e-mail sans clé de signature de désabonnement ne part pas (tentative libérée) ; WhatsApp n'en a pas besoin.
- **Statut devançant l'envoi** : `whatsapp_status_apply` lève `retry_later` pendant 5 minutes après une réclamation de l'intégration, le job est rejoué (au lieu de perdre le statut).

## Limites connues (revue de sécurité J36)
- **Désinscription WhatsApp** : traitée depuis le J36b (`docs/api/whatsapp-inbound.md`, mot d'arrêt → consentement révoqué et numéro supprimé). Reste à faire : retrait en texte libre (humain, boîte J37) et réabonnement (écran contacts J30b).
- **Résultat inconnu** : si Meta a livré mais que la réponse s'est perdue, le message reste `failed` (`send_outcome_unknown`) car l'identifiant `wamid` est inconnu : ne pas proposer « renvoyer » sans vérification (doublon possible).
- **`waba_id`** : fourni à chaque synchronisation et non vérifié (un jeton qui voit plusieurs comptes peut importer les modèles d'un autre compte sur ce canal) ; à enregistrer à la connexion et à vérifier contre le numéro (`/{waba}/phone_numbers`).
- Un modèle supprimé chez Meta n'est pas marqué (aucune notification de statut de modèle) ; pas de pagination au-delà de 200 modèles ; les boutons et cartes des modèles ne sont pas conservés ; le nombre de variables n'est pas comparé aux emplacements `{{n}}` (Meta refuse : `template_invalid`).
- Pas encore de route HTTP ni d'écran pour rattacher un modèle ou approuver (fonctions seulement, comme l'approbation e-mail du J31) : écrans de la boîte de réception (J37, J38).
- La catégorie du modèle n'est pas liée à la finalité approuvée.

## Tests
pgTAP `290_whatsapp_send` (57), adaptateurs (envoi et modèles : 24), worker (WhatsApp : 9), web (synchronisation : 6), acceptation HTTP `whatsapp-send` (9).
