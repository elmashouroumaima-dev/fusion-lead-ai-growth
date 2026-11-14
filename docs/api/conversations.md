# Conversations et messages (J30)

Migration `20261130100000_conversations_messages.sql` (retour arrière : `supabase/rollbacks/20261130100000_conversations_messages.sql`). Spec §7 et §9.3, ADR 005 (décision 13), ADR 007 (E4), ADR 014 (lignes « Conversations »), menaces B3 et C3. Pas d'écran ni de route : l'inbox arrive au J37 ; le service web est dans `apps/web/lib/conversations`.

## Modèle
- **`conversations`** : `contact_id` et `channel_id` (clés étrangères composites), `assignee_id`, `state` (`open`, `pending`, `closed`, `to_triage` ; **`to_triage` sans responsable, `open` et `pending` avec un responsable**, imposé par un CHECK), `handled_by` (`human`, `ai_suggest`), `last_message_at`, `lock_owner` et `lock_expires_at` (verrou humain / IA, J38). **Un seul fil par `(contact, canal)`** : un message entrant sur un fil fermé le rouvre. Le contact et le canal d'un fil ne changent jamais.
- **`messages`** : `conversation_id` et `channel_id` par la clé composite `(organization_id, conversation_id, channel_id)` : **un message ne peut porter ni une autre entreprise, ni un autre canal que sa conversation** (ADR 005, décision 13). `direction`, `provider_message_id`, `body` (1 à 100 000 caractères), `status`, `sent_at`, `received_at`, `error_code`, `idempotency_key`.
  - Statuts : `queued`, `accepted`, `sent`, `delivered`, `read`, `failed`, `bounced`, `cancelled` (ADR 007) et **`received`, réservé aux messages entrants** (écart documenté). Entrant : `provider_message_id` et `received_at` obligatoires ; sortant : `idempotency_key` obligatoire.
  - Unicité `(organization_id, channel_id, provider_message_id)` (un message entrant rejoué ne se duplique pas) et `(organization_id, idempotency_key)` (un envoi rejoué ne crée pas un second message). Un rejeu **identique** (même conversation, même corps) renvoie `duplicate` ; un rejeu qui **contredit** le premier (autre conversation ou autre corps) est un conflit `idempotency_conflict`.
  - Immuables : l'organisation, la conversation, le canal, le sens et le **corps** ; l'identifiant du fournisseur ne change plus une fois connu.
- Colonnes différées (aucune table à référencer aujourd'hui) : `template_*` (J36), `campaign_id` et `segment_snapshot_id` (J42, J43), `approved_by` et `approved_at` (J38, J44).

## Droits (ADR 014) et lecture
| | owner | admin | marketing | commercial | analyste |
|---|---|---|---|---|---|
| Lire conversations et messages | tous | tous | non | **les siens** (`assignee_id = auth.uid()`) | non |
| Assigner | oui | oui | non | non | non |
| Changer l'état | oui | oui | non | **sur les siens** | non |
La file de tri (`to_triage`, sans responsable) n'est visible que d'owner et admin. Les messages héritent des droits de leur conversation (fonction `can_read_conversation`, sans boucle de RLS). Aucune écriture directe, même pour service_role. Un membre suspendu, retiré ou rétrogradé voit ses conversations **libérées** (assignation retirée, file de tri ; un fil fermé reste fermé), comme ses leads.

## Fonctions SQL (SECURITY DEFINER, `search_path` vide, enveloppes `public.*` SECURITY INVOKER)
| Fonction | Rôle | Effet |
|---|---|---|
| `assign_conversation(p_org, p_id, p_assignee)` | owner, admin | le responsable doit être un membre assignable ; assigner sort le fil de la file de tri (`open`), désassigner l'y remet |
| `set_conversation_state(p_org, p_id, p_state)` | owner, admin ; commercial sur les siens | `to_triage` seulement sans responsable, `open` seulement avec un responsable ; un fil d'autrui est « introuvable » pour un commercial |
| `conversation_get_or_create(p_org, p_contact, p_channel)` | **service_role** | idempotente ; contact et canal de l'entreprise (canal non déconnecté) ; nouveau fil en `to_triage` |
| `message_record(p_org, p_conversation, p_direction, p_provider_message_id, p_body, p_idempotency_key, p_event_at)` | **service_role** | entrant (dédupliqué par fournisseur) ou sortant en file (idempotent par clé) ; entrées validées **avant** l'insertion (le DETAIL d'une violation de CHECK recopierait le corps) ; canal déconnecté : introuvable ; 10 000 messages au plus par conversation (`too_many_messages`) ; horodatage limité à maintenant + 5 minutes ; `last_message_at` ne recule jamais ; un entrant rouvre un fil fermé |
Codes : `42501` interdit · `22023` valeur invalide (corps vide ou trop long, identifiant mal formé, état incohérent) · `PT404` introuvable · `P0001` : `assignee_invalid`, `idempotency_conflict`, `too_many_messages`.

## Service web (`apps/web/lib/conversations`)
`listConversations` (25 par page, la plus active d'abord), `getConversation`, `listMessages` (50 par page, seul endroit qui lit le corps), `assignConversation`, `setConversationState`. Tout passe par le client de l'**utilisateur** (la RLS décide), colonnes explicites (jamais de verrou ni d'identifiant fournisseur), entreprise du contexte vérifié. Une conversation interdite et une conversation inexistante sont indiscernables.

## Audit
`conversation.created`, `conversation.assigned`, `conversation.state_changed` : identifiants et états. **Jamais le corps d'un message**, l'identifiant du fournisseur ni la clé d'envoi.

## Boîte de réception (J37)
Pages `/inbox` (liste) et `/inbox/[id]` (fil), ADR 013 (polling, **Proposed**). Migration `20261209100000_inbox.sql` (retour arrière : `supabase/rollbacks/20261209100000_inbox.sql`).
- **Rôles** : owner et admin lisent toutes les conversations de l'entreprise, le commercial **SES conversations** (le fil d'un autre, d'une autre entreprise ou un identifiant invalide donne 404) ; marketing et analyste sont renvoyés au tableau de bord (ADR 014, lignes « Conversations »). Le lien du menu n'apparaît que pour owner, admin et commercial.
- **`search_conversations(p_org, p_state, p_channel, p_assignee, p_unassigned, p_query, p_limit, p_offset, p_conversation)`** : la liste a besoin, en une lecture, du NOM du contact, du TYPE du canal et d'un APERÇU du dernier message ; le commercial ne lit ni `channels` ni les contacts sans lead. La fonction est donc **SECURITY DEFINER** mais **réapplique exactement les droits de lecture des conversations** (`private.can_read_conversation`) et n'expose que : identifiants, nom, e-mail et téléphone du contact, type du canal, état, responsable, **aperçu de 140 caractères** (espaces réduits) et indicateur de troncature, jamais le corps entier, l'identifiant du fournisseur ni la clé d'envoi. Filtres : état, canal (e-mail, WhatsApp), responsable (« moi », « non assignées »), recherche (nom, e-mail, téléphone ; saisie échappée), pagination de 1 à 100 ; une conversation précise par `p_conversation` (en-tête du fil). Exécution : `authenticated` seulement ; sans session : `28000`.
- **Liste** : e-mail et WhatsApp dans une **même liste**, la plus récemment active d'abord, avec canal, état, « non assignée », responsable et aperçu ; filtres en GET (URL partageable), 25 par page.
- **Fil** (lecture) : messages du plus ancien au plus récent (les plus anciens par pages de 50), sens, date, statut des messages sortants ; **le corps complet n'est affiché que dans le fil**. Pas de composeur : les réponses arrivent avec le verrou humain / IA (J38).
- **Commandes** (Server Actions `withAction` : zod strict, contexte tenant relu en base, `can()` ADR 014, limitation de débit, **idempotence obligatoire** ; l'entreprise n'est pas postée) : `inbox.assign` (owner et admin ; « aucun responsable » renvoie le fil au tri) et `inbox.state.set` (owner et admin sur toute conversation, commercial sur les siennes ; « à trier » seulement sans responsable, « ouverte » et « en attente » seulement avec un responsable : la base refuse le reste). Services de J30.
- **Actualisation** (ADR 013) : le composant client `AutoRefresh` appelle `router.refresh()` toutes les **15 s** tant que l'onglet est visible (et au retour dans l'onglet). Aucun endpoint nouveau : la page serveur est redessinée par le même chemin que le chargement initial (client serveur de l'utilisateur, RLS, contexte relu en base), donc aucune donnée ne passe hors des droits de l'appelant.
- **Audit** : `conversation.assigned`, `conversation.state_changed` (identifiants et états) ; **jamais le corps d'un message**.

## Limites connues
- **Un message sortant naît `queued` sans approbation** : `approved_by` et `approved_at` n'arrivent qu'avec J38 et J44. Le worker d'envoi (J31) DOIT exiger la chaîne de contrôle (consentement, `do_not_contact`, approbation, canal actif et non en pause) avant tout appel au fournisseur ; `queued` n'autorise rien par lui-même.
- `handled_by`, `lock_owner` et `lock_expires_at` n'ont encore aucun écrivain (verrou humain / IA au J38).
- `conversations_contact_fkey` est en `on delete restrict` : l'effacement d'un contact qui a des messages (données personnelles dans `body`) demandera une procédure d'anonymisation, à définir avec la responsable technique.
- Les transitions de statut d'un message (`queued` vers `accepted`, `sent`, ...) ne sont pas encore gardées : la machine à états arrive avec l'envoi (J31).
- `listMessages` peut renvoyer 50 corps de 100 000 caractères (environ 5 Mo) par page : un aperçu tronqué est à prévoir pour la liste (J37).
- La RLS des messages appelle `can_read_conversation` par ligne (acceptable jusqu'à environ 10^5 lignes par requête) ; une politique en ligne sera à étudier pour le gros volume.
- Pas d'envoi ni de réception réels (J31, J32, J35) ; `message_record` n'est appelée que par le serveur et le worker.
- Pas de quota `messages_per_month` ni de plafond de conversations par entreprise (J39, avec l'exploitation des envois) ; pas de purge des corps de message (rétention à définir).
- Les transitions de statut d'un message sortant (`queued` vers `accepted`, `sent`, `delivered`, `read`, `failed`) sont définies avec l'envoi (J31).
