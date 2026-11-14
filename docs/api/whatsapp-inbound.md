# Réception WhatsApp : messages et statuts (J35)

Migration `20261205100000_whatsapp_inbound.sql` (retour arrière : `supabase/rollbacks/20261205100000_whatsapp_inbound.sql`, la garde des messages se rejoue depuis `20261201100000`). Spec §9.3 et §13-6, ADR 007. Aucun compte Meta réel : fixtures seulement (test réel à C3).

## Flux
1. Meta envoie `POST /api/webhooks/whatsapp` (J34 : signature `X-Hub-Signature-256`, compte = numéro). `parse` **normalise** le corps (`packages/adapters/src/whatsapp/events.ts`) : seule la forme réduite est conservée dans `webhook_events.payload`.
2. Le job `process_webhook` du worker relit cette forme (`readWhatsAppPayload`) et applique chaque événement par les fonctions SQL service_role `whatsapp_inbound_apply` et `whatsapp_status_apply` (processeur `apps/worker/src/whatsapp-webhook.ts`). L'entreprise et l'intégration sont celles de la **ligne** du job, jamais du contenu.

## Forme conservée (normalisation)
- **Messages reçus** : `from` (chiffres → `+<chiffres>`), type, texte (4096 points de code au plus, NUL retirés, surrogates isolés remplacés). Un **bouton** et une **réponse interactive** (bouton, liste) gardent leur libellé (un « STOP » tapé sur un bouton ne se perd pas) ; un média (image, audio, document...) garde **seulement son type** (`[image]`), sans média ni légende. Les **réactions** et événements **système** sont écartés (pas de message, le fil n'est pas rouvert).
- **Statuts** de nos messages : `sent`, `delivered`, `read`, `failed` (avec le code d'erreur **numérique** de Meta, jamais son texte).
- Jamais conservés : profils des contacts, médias, boutons bruts, objet complet de Meta. Éléments mal formés ou au-delà de 1000 par liste : écartés et comptés (`skipped`) ; une requête qui dépasse 1000 événements au total ou dont la structure n'est pas celle d'un webhook WhatsApp est refusée (400). Un horodatage hors bornes (plus de 10 chiffres, année > 2286) devient « absent » : il ferait échouer tout le lot.

## `whatsapp_inbound_apply` (service_role seulement)
- Intégration `whatsapp` de l'entreprise (statuts `pending`, `active`, `error`), sinon `not_found` (PT404) ; entrées invalides : 22023.
- **Canal** : le canal WhatsApp non déconnecté de l'intégration. Aucun : `no_channel` ; plusieurs : `ambiguous_channel` (jamais de choix au hasard).
- **Contact** : par le numéro **exact** `contacts.phone_e164 = from` **dans l'entreprise** (index unique par entreprise : pas d'ambiguïté, le même numéro dans deux entreprises est isolé). Inconnu : file `inbound_unmatched` (raison `unknown_sender`) et **aucun contact n'est créé**.
- **Déduplication** par identifiant du message chez Meta (`wamid`) : même identifiant et même corps → `duplicate` ; même identifiant avec un autre corps (ou identifiant d'un message sortant) → `id_conflict` dans la file de tri.
- **Fil** : un par contact et canal (J30) ; un fil fermé se rouvre ; fil plein → file de tri (`conversation_full`). Horodatage jamais dans le futur.
- Résultats : `recorded`, `duplicate`, `unmatched` (+ raison), `dropped` (+ `queue_full` = file de tri à 10 000, ou `sender_limit` = 20 par expéditeur).
- Audit : jamais de corps ni de numéro.

## `whatsapp_status_apply` (service_role seulement)
- Le message est cherché dans l'entreprise **et** l'intégration authentifiées (jamais celui d'une autre intégration, même de la même entreprise), par l'identifiant de Meta ; introuvable : `ignored` (`message_not_found`).
- Les statuts n'avancent que dans l'ordre `accepted < sent < delivered < read` : hors ordre (`out_of_order`) ou rejoué (`already_applied`) : ignoré.
- `failed` : accepté tant que le message n'est pas délivré ; l'`error_code` est `wa_<code>` (entier de Meta). Meta ne garantit pas l'ordre : un `failed` de Meta suivi d'un vrai `delivered` ou `read` est **corrigé** (`error_code` effacé ; la garde `messages_guard` autorise cette seule transition, jamais pour un échec posé par la chaîne d'envoi).
- **Limite (prérequis du J36)** : un statut reçu **avant** l'enregistrement de l'envoi (l'identifiant Meta n'est pas encore dans `messages`) est ignoré. Le J36 doit **réclamer l'envoi avant l'appel** et réconcilier comme l'e-mail (J31, J32) pour ne perdre aucun statut.

## Worker (`createWhatsAppWebhookProcessor`)
- Applique chaque événement dans l'ordre ; rejouer une requête est sans danger (tout est dédupliqué, les statuts n'avancent que dans l'ordre).
- File de tri pleine : les **autres** événements de la requête sont traités, puis échec définitif visible (`unmatched_queue_full`, rejouable après le tri) ; `sender_limit` : ignoré.
- Intégration disparue (PT404) ou valeur refusée (22023) : échec **définitif** (`integration_gone`, `invalid_event`) ; les autres erreurs sont réessayées. Aucun texte de message, numéro ni identifiant dans les erreurs ou les journaux.

## Retrait de consentement par mot d'arrêt (J36b, spec §9.3)
Migration `20261207100000_whatsapp_optout.sql` (retour arrière : `supabase/rollbacks/20261207100000_whatsapp_optout.sql`, qui recrée `whatsapp_inbound_apply` du J35).
- **Mot d'arrêt** (`private.is_stop_keyword`) : le message **entier** (ou le libellé d'un bouton) après normalisation : NFKC (largeur pleine, formes décomposées), minuscules, marques invisibles (bidi, largeur nulle) et diacritiques arabes retirés, ponctuation, symboles et émojis aux extrémités ignorés, **espaces ignorés** (« S T O P »). Liste : STOP, STOP ALL, END, QUIT, CANCEL, UNSUBSCRIBE, UNSUB, OPT OUT, REMOVE ME, STOP PROMOTIONS / MESSAGES (libellés de boutons recommandés par Meta), arrêt / arrête / arrêtez, désabonner / se désabonner, désinscription, إيقاف, توقف, أوقف, إلغاء, إلغاء الاشتراك. Une phrase qui **contient** « stop » (« please stop sending me this ») n'est **pas** un mot d'arrêt.
- **Effet** pour un contact connu (comme le désabonnement e-mail du J33) : consentements **WhatsApp** révoqués (historique conservé ; l'e-mail intact), numéro inscrit dans `suppressions` (raison `unsubscribe`, message source tracé), messages WhatsApp en file non réclamés et leurs jobs annulés, audit sans numéro ni texte (et seulement si quelque chose a changé). `do_not_contact` n'est **pas** modifié. Le retrait est fait même si le fil est plein ou l'identifiant en conflit.
- **Numéro sans contact** (expéditeur inconnu, aucun canal, canal ambigu) : seul le **numéro** est supprimé, aucun contact n'est créé ; l'envoi reste bloqué si un contact porte ce numéro plus tard.
- **Rattrapage** (une fois, en fin de migration) : les mots d'arrêt déjà reçus et enregistrés par le J35 sont honorés, sauf nouveau consentement WhatsApp depuis.
- Un envoi déjà **réclamé** par le worker n'est pas annulé ici (le contrôle final le refuse s'il n'est pas encore parti ; sinon l'appel peut partir dans les secondes qui suivent : même fenêtre que le J33). Un « STOP » ne reçoit **aucune réponse automatique**.

## Limites connues
- **Numéros non canoniques** : WhatsApp rapporte certains numéros sous une forme différente de l'E.164 saisi (Mexique `521…`, Argentine `549…`, variantes brésiliennes du 9ᵉ chiffre) : ils tombent dans `unknown_sender` (aucune fuite ; pas de correspondance approximative). Des alias par pays seront ajoutés plus tard, jamais un rapprochement flou.
- **Retrait en texte libre** (« ne m'écrivez plus », « arrêtez d'envoyer ») : seul le message ENTIER égal à un mot d'arrêt est traité automatiquement (voir ci-dessous) ; le texte libre reste à traiter par un humain dans la boîte de réception (J37).
- **Réabonnement** : il n'existe pas encore ; un contact qui écrit START reste supprimé (action auditée à prévoir, écran contacts J30b).
- Les cas ignorés (`out_of_order`, `status_conflict`) ne laissent pas de trace dédiée (observabilité à voir au J39).

## Tests
pgTAP `280_whatsapp_inbound` (44), `300_whatsapp_optout` (53), adaptateurs (événements : 11), worker (8), acceptation HTTP `whatsapp-flow` (7).
