# Pack de revue de sécurité : Phase 3 (canaux)

- **Date du pack** : 2026-11-24 (état de `main` après les PR 75 et 76).
- **Objet** : permettre à la responsable technique de faire la revue de sécurité de la Phase 3 **avant G3** (décision C5 du 2026-11-21). Une revue par un tiers reste exigée **avant le premier client réel**.
- **Écart C3 visé** : n° 6 de `docs/checkpoints/C3.md` (« revue de sécurité indépendante de J39, J39b, J39c, J40 et du durcissement `reply` »). Le périmètre ci-dessous y ajoute ce qui a été construit depuis : Kapso (ADR 017), réponse WhatsApp, consentement conversationnel de 7 jours, activation des canaux, Resend (ADR 008, note du 2026-11-23 et 24).
- **Ce pack ne remplace pas la revue** : il donne le périmètre, l'ordre de lecture, une checklist et les preuves automatiques. Une **première passe par quatre agents indépendants** (2026-11-24) est consignée en section 7.1 ; le verdict est à porter en section 7.2.

## 1. Comment lire ce pack
1. Lire `docs/security/threat-model.md` (menaces A à G) : la checklist de la section 4 en reprend les identifiants.
2. Lire dans l'ordre les fichiers de la section 3 (≈ 3 heures pour les 12 fichiers à plus fort risque).
3. Cocher la section 4 ; noter chaque constat en section 7 (gravité, fichier, ligne, preuve).
4. Rejouer au besoin les scans de la section 5 (commandes fournies).

## 2. Périmètre

| Zone | Migrations (`supabase/migrations/`) | Tests de base (`supabase/tests/database/`) | Code principal | Documentation |
|---|---|---|---|---|
| **J38** Réponses et verrou de conversation | `20261210100000_replies_lock`, `20261210120000_message_send_claim_merge`, `20261212100000_reply_purpose_reserved`, `20261218100000_reply_consent_7_days` | `270_replies_lock`, `310_reply_purpose`, `360_reply_consent_7_days` | `apps/web/app/api/conversations/[id]/`, `apps/web/lib/conversations/service.ts`, `apps/web/components/inbox/reply-composer.tsx` | `docs/api/conversations.md`, ADR 014 (amendement J38) |
| **J39** Exploitation des envois (arrêt d'urgence, rejeu, alerte, débit) | `20261211100000_send_operations` | (couvert par `240_send_chain` et `080_jobs`) | `apps/web/lib/operations/service.ts`, `apps/web/components/operations/`, `apps/worker/src/handlers.ts` | `docs/api/send-operations.md`, `docs/runbooks/emergency-stop.md` |
| **J39b** Écrans de configuration (clés de formulaire, règles d'assignation, notifications) | `20261123100000_form_keys_capture`, `20261124100000_assignment` | `160_capture`, `170_assignment` | `apps/web/app/api/forms/keys/`, `apps/web/lib/forms/service.ts`, `apps/web/lib/assignment/service.ts` | `docs/api/config-screens.md` |
| **J39c** Import CSV (écran, lots, rapport) | `20261125100000_imports` | `180_imports` | `apps/web/app/api/imports/`, `apps/web/lib/imports/service.ts`, `apps/worker/src/imports.ts` | `docs/api/imports.md` |
| **J40** Scénarios des canaux | : | : | `tests/acceptance/src/` (séries e-mail et WhatsApp) | `docs/testing/strategy.md` |
| **Durcissement `reply`** | `20261212100000_reply_purpose_reserved` | `310_reply_purpose` | `message_approve` refuse la finalité `reply` | ADR 014 |
| **Activation des canaux** | `20261213100000_channels_activation` | `320_channels_activation` | `apps/web/app/api/channels/` | `docs/api/integrations.md` |
| **Passerelles** (WhatsApp Kapso, e-mail Resend) | `20261215100000_integration_gateway`, `20261219100000_email_gateway_resend` | `330_integration_gateway` | `packages/adapters/src/whatsapp/kapso.ts`, `packages/adapters/src/email/resend*.ts`, `gateway.ts` | ADR 017, ADR 008 |
| **Réponse et STOP WhatsApp** | `20261216100000_whatsapp_reply`, `20261217100000_whatsapp_marketing_optout` | `340_whatsapp_reply`, `350_whatsapp_marketing_optout` | `apps/worker/src/whatsapp-webhook.ts` | `docs/api/whatsapp-*.md` |
| **Webhooks** (Postmark, Meta, Kapso, Resend) | `20261129100000_webhook_events`, `20261202100000_email_inbound` | `220_webhook_events`, `250_email_inbound` | `apps/web/app/api/webhooks/[provider]/route.ts`, `apps/web/lib/webhooks/handle.ts`, `packages/adapters/src/webhooks/ingest.ts`, `packages/adapters/src/email/*-webhook.ts` | `docs/api/webhooks.md`, `docs/runbooks/email-webhooks.md` |

## 3. Ordre de lecture proposé (fichiers à plus fort risque d'abord)
1. `packages/domain/src/outbound/send.ts` : `checkCanSend` (chaîne de contrôles, échec fermé).
2. `supabase/migrations/20261218100000_reply_consent_7_days.sql` : version courante de `message_send_claim` (la dernière migration qui la redéfinit fait foi ; voir aussi `20261210120000_message_send_claim_merge.sql` et `20261212100000_reply_purpose_reserved.sql`).
3. `apps/worker/src/handlers.ts` : `send_message` (claim, contrôle final, appel fournisseur, résultat ; au plus un envoi par message).
4. `packages/adapters/src/webhooks/ingest.ts` : ordre des contrôles (taille, lecture, compte, signature, fenêtre, déduplication).
5. `packages/adapters/src/email/resend-webhook.ts` (signature Svix) et `packages/adapters/src/whatsapp/kapso.ts` (HMAC).
6. `packages/adapters/src/email/resend-receive.ts` + `apps/worker/src/email-webhook.ts` : relecture d'un message entrant par l'API (clé de l'intégration, adresse fixe).
7. `apps/web/lib/webhooks/handle.ts` et `apps/web/app/api/webhooks/[provider]/route.ts` : HTTPS, débit, journaux.
8. `supabase/migrations/20261211100000_send_operations.sql` : arrêt d'urgence, rejeu humain.
9. `supabase/migrations/20261210100000_replies_lock.sql` : `conversation_reply`, verrou, droits du commercial.
10. `apps/web/lib/integrations/service.ts` et `apps/web/lib/service/integration-secrets.ts` : chiffrement et lecture des secrets (jamais renvoyés).
11. `supabase/migrations/20261215100000_integration_gateway.sql` et `20261219100000_email_gateway_resend.sql` : validation de la passerelle, fonctions `security definer`.
12. `apps/web/lib/imports/service.ts` + `apps/worker/src/imports.ts` : fichiers importés, tailles, formules CSV.

## 4. Checklist (à cocher ; chaque ligne cite la menace du modèle)

**Isolation et droits (A, B)**
- [ ] Aucune route ne fait confiance à un `organization_id` du client sans le comparer au contexte vérifié (`withRoute`).
- [ ] Chaque fonction `security definer` fixe `search_path` ; les fonctions `public` sont des enveloppes `invoker` (scan B4, B5).
- [ ] `message_approve` refuse `reply` ; le commercial ne répond qu'à SA conversation ; marketing et analyste ne répondent pas.
- [ ] Les fonctions de webhook, de réclamation d'envoi et de lecture de secret ne sont exécutables que par `service_role` (scan B8c, B8d).
- [ ] Beta ne lit, ne remplace ni ne déconnecte rien d'Alpha (tests d'acceptation `integrations-flow`).

**Webhooks et fournisseurs (C)**
- [ ] Signature vérifiée sur le **corps brut**, comparaison à temps constant, **avant** toute écriture ; compte inconnu = même 401 qu'une signature fausse.
- [ ] Fenêtre d'horodatage de 5 minutes ; déduplication par un identifiant tiré du contenu signé.
- [ ] Une intégration sans secret ou déconnectée n'authentifie rien.
- [ ] HTTPS exigé hors développement local ; corps limité en taille ; aucun payload ni secret dans les journaux ni les réponses.
- [ ] **Resend** : signature Svix (`whsec_`), `received_for` (et non `to`) pour désigner le canal, expéditeur « authentifié » seulement si `dmarc` = `pass`, appel d'API à adresse fixe avec identifiant validé.
- [ ] Un événement inconnu est acquitté et ignoré (jamais un refus qui ferait désactiver le webhook).

**Secrets (D)**
- [ ] Clés d'API et secrets de webhook chiffrés en base (AES-256-GCM), jamais lisibles par un rôle applicatif, jamais renvoyés, jamais dans l'audit, les clés d'idempotence, les jobs ni les journaux (scans C, T3).
- [ ] Le secret de webhook est distinct de la clé d'envoi (contrôlé à l'enregistrement).
- [ ] Aucun `service_role` ni jeton côté navigateur ; seules deux variables `NEXT_PUBLIC_` (scan A2, A3).

**Envoi non consenti (F)**
- [ ] Aucun appel fournisseur hors du handler `send_message` du worker.
- [ ] Approbation humaine **revalidée à l'envoi** (approbateur toujours owner/admin actif, adresse inchangée, moins de 72 h).
- [ ] Consentement, « ne plus contacter », suppression, pause (canal, entreprise), arrêt d'urgence, fenêtre WhatsApp, modèle approuvé, débit : refus **avant** l'appel, avec un code court.
- [ ] Résultat inconnu = jamais renvoyé automatiquement ; 5xx autre que 503 = incertain.
- [ ] Désabonnement (lien signé, un clic) et STOP WhatsApp révoquent le consentement, suppriment l'adresse et annulent les envois en file.

**Injection et contenus (E, G)**
- [ ] Un seul `dangerouslySetInnerHTML` (palette), alimenté par des hex validés (scan D).
- [ ] Import CSV : taille, encodage, protection contre les formules, rapport sans donnée de contact.
- [ ] Aucun hôte sortant choisi par un utilisateur : toutes les adresses de fournisseur sont fixes (scan I).

**Exploitation (G)**
- [ ] Arrêt d'urgence relu à chaque envoi ; rejeu d'un job en échec par un humain identifié et audité.
- [ ] Journal de l'application caviardé ; journal du worker à champs fixes ; audit sans corps de message.
- [ ] Mutations rejouables : `Idempotency-Key` obligatoire (scan H).

## 5. Résultats des scans automatiques (2026-11-24)

| Réf. | Contrôle | Résultat | Commande ou méthode |
|---|---|---|---|
| A1 | n8n, MCP, WhatsApp non officiel (`baileys`, `whatsapp-web.js`, `wppconnect`, `venom`, `puppeteer`) | **0 occurrence** | `git grep -n -i -E "n8n|baileys|whatsapp-web\.js|wppconnect|venom-bot|puppeteer|@modelcontextprotocol" -- apps packages supabase scripts tests` |
| A2 | Variables `NEXT_PUBLIC_*` | Deux réelles (`…SUPABASE_URL`, `…PUBLISHABLE_KEY`) ; `…SECRETS_MASTER_KEY` et `…SERVICE_ROLE_KEY` n'apparaissent que dans les tests qui vérifient leur **refus** | `git grep -h -o -E "NEXT_PUBLIC_[A-Z_]+" -- apps packages` |
| A3 | `service_role` ou clé secrète dans un composant navigateur | **Aucun** (une seule citation, dans un commentaire de `member-actions.tsx`) ; aucun fichier `use client` n'importe `createAdminClient` | parcours des fichiers `use client` |
| A4 | `user_metadata` pour une autorisation | **Aucun** : seul usage = la langue de l'interface (`lib/auth/actions.ts:82`) | `git grep -n user_metadata` |
| B1, B2 | Tables `public` / RLS | **34 / 34** avec RLS ; aucune sans RLS | requête `pg_class` (base locale) |
| B3 | `organization_id` nullable | **1** : `rate_limit_buckets` (seaux par adresse IP, pas des données d'entreprise) | `information_schema.columns` |
| B4, B5 | `security definer` sans `search_path` ; `security definer` dans `public` | **Aucune** ; **aucune** | `pg_proc` |
| B6, B7 | Fonctions ou tables `public` accessibles à `anon` | **Aucune** ; **aucune** | `has_function_privilege`, `role_table_grants` |
| B8 | Schéma `private` | Aucune table lisible par `authenticated` ni `anon` ; 91 fonctions exécutables par `authenticated` (enveloppes appelées par les fonctions `public`) ; **0** pour `anon` ; aucune fonction de webhook, de réclamation, d'application d'événement ni de lecture de secret n'est exécutable par `authenticated` | `pg_proc`, `has_function_privilege` |
| B8d | Fonctions `public` réservées à `service_role` | 17 (webhooks, `message_*`, `email_*`, `whatsapp_*`, `get_integration_secret`) | `pg_proc` |
| B9 | RLS activée sans politique (refus total voulu) | `idempotency_keys`, `rate_limit_buckets`, `platform_config` (accès par fonctions seulement) | `pg_policy` |
| C | Motifs de secrets dans les fichiers suivis (`re_…`, `whsec_…`, `sk_live_…`, JWT, clés privées) | **1** faux positif : constante factice d'un test (`pipeline.contract.test.ts`) | `git grep -n -I -E …` |
| C' | Même recherche dans les tables de la base locale (audit, jobs, idempotence, webhooks, messages, intégrations, notifications) et les journaux (serveur de développement, 11 conteneurs) | **0** | essai du 24 novembre (T3) |
| D | Puits XSS (`dangerouslySetInnerHTML`, `innerHTML =`, `eval`, `new Function`) | **1** : `app/[locale]/layout.tsx:59`, palette ; `paletteToCss` n'écrit que des hex validés (`HEX_COLOR`, erreur sinon) | `git grep -n` |
| E | Dépendances de production | **Aucune vulnérabilité connue** | `pnpm audit --prod` |
| H | Routes `POST` sans idempotence ni enveloppe de contrôle | **Aucune** | parcours de `apps/web/app/api/**/route.ts` |
| I | Appels sortants | Adresses fixes dans `packages/adapters` ; les `fetch` du navigateur ne visent que l'API de l'application | `git grep -l "fetch("` |
| CI | Lint, typecheck, tests ; pgTAP, lint du schéma, RLS ; acceptation HTTP réelle | **verts** sur `main` (PR 75, 76 ; PR 77 en cours) | GitHub Actions |

**Non faits** (à signaler au relecteur) : analyse statique dédiée (Semgrep, CodeQL) et détecteur de secrets sur l'historique (gitleaks) non installés ; aucun test d'intrusion dynamique ; le terminal du worker n'a pas été relu pour T3 ; `pnpm test:rls` et pgTAP n'ont pas été relancés en local (Docker au moment de l'essai) mais passent en CI.

## 6. Points d'attention pour le relecteur
1. **Version de `message_send_claim`** : plusieurs migrations la redéfinissent ; la dernière (`20261218100000_reply_consent_7_days.sql`) fait foi. Vérifier qu'aucune branche de logique d'une version antérieure n'a été perdue (le test `240_send_chain` et `360_reply_consent_7_days` la couvrent).
2. **Exigence HTTPS des webhooks** : la route lit `x-forwarded-proto` du proxy de confiance (`TRUSTED_PROXY_HOPS`). Derrière un proxy mal configuré, l'en-tête pourrait être forgé : cela ne contourne **pas** l'authentification (signature ou secret), seulement l'exigence de transport. À vérifier au déploiement (VPS, option A).
3. **Resend** : la forme réelle de la réponse de l'API de réception (`received_for`, `authentication`, en-têtes), le type de rebond « Permanent », la validation d'une clé « envoi seul » et l'algorithme exact de la signature Svix sont **À CONFIRMER** ; seuls l'envoi, la livraison par webhook signé, le rejeu et les refus ont été essayés pour de vrai (`docs/testing/parts/08-email-resend.md`). La réception n'est pas essayée (domaine privé requis).
4. **Postmark** : webhook par Basic Auth (le secret circule à chaque requête), décision actée (ADR 008) ; HTTPS obligatoire.
5. **Adresses réservées** : une intégration ou un canal déconnecté garde son adresse (contraintes uniques sans filtre sur l'état) ; comportement existant, à confirmer (ou à assouplir).
6. **Pas d'information de pourriel** dans la réception Resend (`spam` toujours faux) : l'expéditeur inconnu va dans la file des cas ambigus, jamais en contact.
7. **Clés d'API de test** : une clé Resend a été collée dans une conversation : elle doit être révoquée (hygiène, hors code).
8. **Rotation** : le trousseau de production n'a qu'une clé (`docs/runbooks/secret-rotation.md`) ; décision à prendre avant la première rotation.
9. **Données personnelles** : effacement d'un contact qui a des messages (droit à l'effacement) et purge des événements de webhook : non faits (backlog).

## 7. Résultat de la revue

### 7.1 Première passe : revue indépendante par quatre agents (2026-11-24)
Quatre relectures **en lecture seule**, sans le contexte de la session qui a écrit le code (envoi ; webhooks ; secrets et intégrations ; réponses, consentement, import, clés de formulaire). **Ce sont des constats d'agents, pas un verdict** : chacun est à confirmer ou à écarter par la responsable technique. Seul S-01 a été **reproduit** (mesure : 80 000 « < » = 4,2 s) ; S-02 est cohérent avec l'index unique lu dans `20261128100000_integrations_secrets.sql:61` et avec l'essai du 24 novembre (une adresse déconnectée reste réservée). Aucun constat **critique**. Points forts relevés : approbation et contrôle final dans le claim, une seule tentative par message, résultat inconnu jamais rejoué, droits SQL par rôle, `search_path` fixé partout, secrets chiffrés par entreprise, signatures à temps constant, expéditeur inconnu jamais promu en contact.

| N° | Gravité | Fichier | Constat | Proposition | Décision (corriger, accepter, reporter) | Statut |
|---|---|---|---|---|---|---|
| S-01 | **Haute** | `packages/adapters/src/email/resend-receive.ts` (`htmlToText`) | Expressions régulières quadratiques sur le HTML d'un e-mail entrant (contrôlé par l'expéditeur) : plafond de 2 Mo = environ 44 minutes de CPU ; le worker est partagé par toutes les entreprises. | Parcours linéaire et plafond d'entrée de 200 Ko. | | **Corrigé** (branche `fix-review-resend-receive` ; test : 2 millions de « < » en moins de 500 ms) |
| S-02 | **Haute** | `20261128100000_integrations_secrets.sql:61`, `create_provider_integration`, `resend-validate.ts`, `postmark-validate.ts` | **Réservation de compte entre entreprises** : l'index unique `(provider, external_account_id)` est global, sans filtre d'état, et rien ne prouve que l'entreprise possède le numéro ou le domaine (la validation Resend et Postmark ne lie pas la clé au compte). Une entreprise peut bloquer la connexion d'une autre ; les webhooks de la victime se résolvent vers la mauvaise ligne ; la déconnexion ne libère pas le compte ; le 409 révèle qu'un compte est pris (oracle). | Index unique partiel sur les intégrations `active` ; plusieurs `pending` possibles ; preuve de propriété à la validation (Resend : le domaine figure dans `GET /domains` ; WhatsApp : déjà lié au jeton) ; libérer le compte à la déconnexion. | | **Corrigé** (branche `fix-s02-account-reservation`, ADR 018 : unicité par entreprise, résolution des webhooks par signature) |
| S-03 | Moyenne | `20261123100000_form_keys_capture.sql:353-380` | Un tiers connaissant la clé (publique) du formulaire peut enregistrer un consentement marketing actif pour un contact existant sans historique, sans double confirmation. | Double opt-in (consentement « en attente » jusqu'au clic), ou refuser le consentement sur un contact préexistant sans consentement. | | **Corrigé** (branche `fix-s03-form-consent`, ADR 007 amendement : consentement du formulaire effectif une fois prouvé ; pas de double opt-in automatique, interdit par la spec) |
| S-04 | Moyenne | `20261218100000_reply_consent_7_days.sql:64-75`, `private.revoke_consent` | Une **réponse** reste couverte par un message entrant de moins de 7 jours même si le consentement a été révoqué (sans « ne plus contacter ») ; les mots d'arrêt ne sont traités que pour WhatsApp, pas pour l'e-mail ; une réponse automatique ouvre aussi la fenêtre. | Refuser la réponse si une révocation est plus récente que le dernier entrant ; la révocation annule les envois en file ; mots d'arrêt et en-têtes `Auto-Submitted` pour l'e-mail. | | **Corrigé en partie** (branche `fix-s04-s05-consent-emergency-stop` : réponse et révocation, annulation des envois en file ; restent : mots d'arrêt et réponses automatiques pour l'e-mail) |
| S-05 | Moyenne | `20261211100000_send_operations.sql:128-140`, `core_rls_policies.sql:24,42-45`, `handlers.ts:380-457,417-423` | Arrêt d'urgence : (a) le responsable marketing peut aussi **reprendre** les envois ; (b) owner et admin peuvent modifier `settings.send_paused` directement, sans audit ; (c) l'arrêt n'est lu qu'au claim (la lecture du secret passe après) ; (d) à l'arrêt, les messages en file échouent définitivement et doivent être recréés. | Reprise réservée à owner/admin ; interdire l'écriture directe de `send_paused` ; lire le secret avant le claim ; mettre en attente plutôt qu'échouer. | | **Corrigé en partie** (reprise réservée à owner et admin, `send_paused` gardé par un déclencheur ; restent : lecture du secret après le claim, mise en attente plutôt qu'échec définitif des envois en file pendant un arrêt) |
| S-06 | Moyenne | `ingest.ts:54`, `resend-webhook.ts:58-61`, `whatsapp/events.ts:116`, `kapso.ts:114` | Des événements non pertinents ou sans compte (`domain.*`, `account_update` Meta, lot de deux numéros) reçoivent **400** au lieu d'un acquittement : le fournisseur réessaie puis peut désactiver le webhook ; pour Meta, des messages d'un lot multi-numéros peuvent être perdus. | Répondre 200 « ignoré » (sans écriture) quand le JSON est valide mais sans compte ; résoudre par numéro pour les lots. | | À traiter |
| S-07 | Moyenne (à confirmer) | `resend-webhook.ts:34-39`, `resend-receive.ts` | `From` à plusieurs adresses : DMARC peut avoir été évalué sur l'une, l'application retient l'autre : usurpation d'un contact. | Refuser tout `From` avec plus d'une adresse ; confirmer la forme de `authentication` sur un compte réel. | | À traiter |
| S-08 | Moyenne | `20261128100000_integrations_secrets.sql:195-199`, `20261213100000_channels_activation.sql:50-92` | Remplacer le jeton d'une intégration **active** la laisse active (et ses canaux) sans nouvelle validation ; la validation d'un ancien jeton peut activer le nouveau (course). | Repasser à `pending` à chaque remplacement ; lier la validation au `secret_id` validé. | | À traiter |
| S-09 | Moyenne | `apps/web/lib/imports/service.ts:277`, `20261125100000_imports.sql:263-266` | Les fichiers CSV importés (données personnelles) ne sont jamais supprimés après l'import ; les lots « uploaded » abandonnés bloquent les imports suivants (10 au plus). | Supprimer à la fin ou à l'échec ; job de purge ; expiration à 24 h. | | À traiter |
| S-10 | Moyenne | `apps/web/app/api/leads/route.ts`, `rate-limit.ts` | La capture publique n'est protégée que par l'en-tête `Origin` (falsifiable hors navigateur) : épuisement du seau de la clé ou du quota de contacts ; le 429 `quota_exceeded` révèle l'état du quota. | Défi anti-robot ou nonce signé ; plafond par clé et par jour ; réponse générique. | | À traiter |
| S-11 | Moyenne | `apps/web/lib/smtp/secrets.ts`, `apps/worker/src/index.ts:22-24` | Trousseau à une seule clé : une rotation rend tous les secrets illisibles (déjà noté, `secret-rotation.md`). | `SECRETS_PREVIOUS_KEYS` partagé par le web et le worker ; job de rechiffrement. | | Connu |
| S-12 | Moyenne | `20261202100000_email_inbound.sql:33`, `integrations/secret/route.ts` | « Secret de webhook différent du jeton d'envoi » n'est contrôlé que dans l'application (lecture puis écriture) ; la contrainte SQL compare deux identifiants toujours différents. | Contrôle atomique (empreinte HMAC) ; retirer l'exécution directe des fonctions d'écriture aux utilisateurs. | | À traiter |

**Faibles et informatifs (regroupés)** : identifiant d'événement Resend pouvant violer la contrainte de `webhook_events` (hacher comme `eventKey`) ; **identifiant de message `..` dans l'adresse de relecture Resend (corrigé avec S-01)** ; déduplication qui peut avaler un STOP Kapso répété ; message Resend légitime perdu s'il dépasse 2 Mo ou en cas de 400/410 (le mettre dans la file des cas ambigus ou alerter) ; exigence HTTPS fondée sur `SITE_URL` et `x-forwarded-proto` (préférer `NODE_ENV`, et l'imposer au proxy) ; temps de réponse distinct pour un compte inconnu ; rejeu limité à la déduplication (Postmark, Meta, Kapso) ; Postmark : authentification de l'expéditeur fondée sur la présence d'un seul en-tête, repli sur `To` ; désabonnement qui renvoie 400 (au lieu de 503) si le trousseau manque ou si une version de clé est retirée ; `conversation_reply` n'applique pas à l'e-mail le contrôle de fenêtre, l'abonnement ni la pause du canal (le worker refuse ensuite : faux « en file ») ; verrou de conversation non libéré à la réassignation ; règles zod absentes de SQL (numéro WhatsApp) ; `create_channel` accepte une intégration `disabled`, expéditeur non vérifié ; fichier d'import remplaçable entre aperçu et exécution (borné) ; repli de seau de débit « unknown » si l'adresse IP est introuvable ; clés d'idempotence de message à l'échelle de l'entreprise ; `past_due` et essai autorisés à envoyer (politique à confirmer) ; suppression par adresse exacte (alias non gérés).

### 7.2 Décision de la responsable technique
- **Relecteur** : ______________________  **Date** : ____________
- **Verdict** : ☐ pas d'écart bloquant ☐ écarts à corriger avant G3 (colonne « Décision » ci-dessus)
- **Revue par un tiers** (avant le premier client réel, décision C5) : ☐ planifiée le ____________
