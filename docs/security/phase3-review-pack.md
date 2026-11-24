# Pack de revue de sécurité : Phase 3 (canaux)

- **Date du pack** : 2026-11-24 (état de `main` après les PR 75 et 76).
- **Objet** : permettre à la responsable technique de faire la revue de sécurité de la Phase 3 **avant G3** (décision C5 du 2026-11-21). Une revue par un tiers reste exigée **avant le premier client réel**.
- **Écart C3 visé** : n° 6 de `docs/checkpoints/C3.md` (« revue de sécurité indépendante de J39, J39b, J39c, J40 et du durcissement `reply` »). Le périmètre ci-dessous y ajoute ce qui a été construit depuis : Kapso (ADR 017), réponse WhatsApp, consentement conversationnel de 7 jours, activation des canaux, Resend (ADR 008, note du 2026-11-23 et 24).
- **Ce pack ne remplace pas la revue** : il donne le périmètre, l'ordre de lecture, une checklist et les preuves automatiques. Le verdict est à porter en section 7.

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

## 7. Résultat de la revue (à remplir par la responsable technique)

| N° | Gravité | Fichier et ligne | Constat | Décision (corriger, accepter, reporter) | Statut |
|---|---|---|---|---|---|
| 1 | | | | | |

- **Relecteur** : ______________________  **Date** : ____________
- **Verdict** : ☐ pas d'écart bloquant ☐ écarts à corriger avant G3 (liste ci-dessus)
- **Revue par un tiers** (avant le premier client réel, décision C5) : ☐ planifiée le ____________
