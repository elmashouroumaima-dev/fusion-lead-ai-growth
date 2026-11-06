# Modèle de menaces STRIDE — Fusion Leap AI Growth

- **Statut :** Proposed (J3, gate G0')
- **Sources :** spec §2, §7.2, §8, §9, §10, §11, §13 ; ADR 003–005, 007, 008, 012, 014 ; `docs/analysis/gaps-and-questions.md`
- **Périmètre :** fuite inter-tenant, élévation de rôle, webhooks forgés ou rejoués, jetons OAuth/secrets, injection de prompt via messages entrants, envoi non consenti ; plus les menaces d'exploitation les plus plausibles.
- **Règle :** chaque menace a un **contrôle** et un **test qui le prouve** (numéro de jour du plan). Une menace sans test planifié est une dette signalée au checkpoint.

STRIDE : **S**poofing (usurpation) · **T**ampering (altération) · **R**epudiation · **I**nformation disclosure · **D**enial of service · **E**levation of privilege.

## 1. Actifs et frontières
Actifs : données des entreprises (contacts, conversations, campagnes), secrets d'intégration, `service_role`, clé maîtresse de chiffrement, journal d'audit, capacité d'envoi (réputation e-mail/WhatsApp).
Frontières : navigateur ↔ Next.js ; navigateur ↔ Data API (RLS) ; fournisseur ↔ webhook ; worker ↔ fournisseur ; contenu client ↔ IA ; Platform Admin ↔ données client. Voir `docs/architecture/data-flow.md` §7.

## 2. Menaces

### A. Isolation inter-tenant (critère §13-1)
| ID | STRIDE | Menace | Contrôle | Test (jour) |
|---|---|---|---|---|
| A1 | I | Utilisateur de l'entreprise A lit/modifie une ligne de B via la Data API en changeant un identifiant | RLS par opération (`USING`+`WITH CHECK`) sur toute table tenant ; `GRANT` minimal ; FK composites (ADR 005) | Matrice RLS utilisateur × entreprise × CRUD par table (J7 puis à chaque migration) ; T1 (J15) |
| A2 | T | `UPDATE … SET organization_id` pour transférer une ligne chez B | Trigger anti-transfert + `WITH CHECK` | Test « changement d'`organization_id` refusé » (J7) |
| A3 | I | API serveur fait confiance à un `organization_id` du corps/de l'URL | `getTenantContext()` revérifie l'adhésion à chaque requête ; comparaison contexte/identifiant (ADR 005 §7) | Org forgée → 403 ; deep link ancienne org refusé (J9, T5 J15) |
| A4 | I | Fuite via `service_role` du worker/API (RLS contournée) | Handlers qui reçoivent et appliquent `organization_id` explicite ; requêtes toujours filtrées ; revue de chaque accès `service_role` | Tests de handlers avec deux organisations (J13, J15) ; audit de conformité (checkpoints) |
| A5 | I | Fuite par Storage, export CSV, recherche, temps réel | Politiques Storage par préfixe d'organisation, URL signées courtes ; export via requêtes soumises à la RLS + audit ; Realtime filtré par RLS ou polling (ADR 013) | Tests Storage (J17) ; recherche/export Playwright (J24) ; temps réel inter-tenant (J37) |
| A6 | I | Contexte IA contenant des données d'une autre entreprise | Fonctions de lecture filtrées par organisation/projet ; liste blanche de champs (ADR 012) | Test d'isolation du contexte (J47) |
| A7 | I/E | Boucle ou contournement dans les fonctions d'aide `security definer` (search_path détourné) | `set search_path = ''`, noms qualifiés, schéma `private` non exposé | Test que `private.*` n'est pas appelable par `authenticated` via l'API (J6–J7) ; revue GRANT (J57) |
| A8 | I | Mélange de compteurs d'usage / de quotas entre entreprises | `usage_counters` scopés par organisation ; incrément atomique | Test d'isolation des compteurs (J14, J60) |
| A9 | I | Un même compte fournisseur lié à deux entreprises (webhook vers le mauvais tenant) | `unique (provider, external_account_id)` global (ADR 005 §9) | Test de connexion d'un compte déjà lié (J28) |

### B. Authentification, rôles, élévation de privilège (critère §13-2)
| ID | STRIDE | Menace | Contrôle | Test (jour) |
|---|---|---|---|---|
| B1 | E | Un utilisateur modifie son rôle via `user_metadata` | Rôle lu uniquement dans `organization_members` ; jamais `user_metadata` ni rôle dans le JWT (ADR 005 §5) | Grep CI/lint SQL interdisant `raw_user_meta_data`/`user_metadata` dans les politiques ; test de modification de métadonnées sans effet (J7–J10) |
| B2 | E | Company Admin s'attribue ou retire le rôle d'Owner / transfère la propriété | Matrice ADR 014 ; contrôle service + RLS ; dernier Owner non supprimable | Matrice `can()` exhaustive (J10) ; tests RLS rôle × action |
| B3 | E | Sales Agent lit des leads/conversations non assignés | RLS `assignee_id = auth.uid()` ; | Tests négatifs (J20, J30, J26) |
| B4 | E | Analyst envoie ou lit les PII | Aucun droit d'écriture ni de lecture de contacts (ADR 014) | Test Analyst (J7, J26, J44) |
| B5 | S | Session volée / fixation / CSRF sur mutations par cookie | Cookies `httpOnly`/`secure`/`sameSite`, CSRF sur mutations par cookie, rafraîchissement SSR | Tests CSRF et sessions (J8, J57) |
| B6 | E | Invitation rejouée ou jeton deviné | Jeton aléatoire haché en base, expiration, usage unique | Tests d'invitation expirée/rejouée (J10) |
| B7 | E | Platform Admin lit les données client hors session | `support_sessions` active obligatoire dans les politiques ; accès audité ; expiration | Tests d'expiration et d'accès refusé (J56) |
| B8 | S | Contournement de la limite de débit (brute force login, spam d'API) | Rate limit IP + organisation (J11) ; protections d'authentification Supabase | Test de dépassement (J11) |

### C. Webhooks et fournisseurs (critères §13-5, §13-6)
| ID | STRIDE | Menace | Contrôle | Test (jour) |
|---|---|---|---|---|
| C1 | S | Webhook forgé sans signature/secret valide | Vérification de signature (WhatsApp `X-Hub-Signature-256`, Salla HMAC) ou secret propre au canal (e-mail, voir fiche) sur le **corps brut** ; comparaison à temps constant | Signature invalide rejetée + journalisée (J29, J34) |
| C2 | T | Rejeu d'un webhook valide | Déduplication `unique (provider, external_event_id)` ; timestamp quand disponible | Webhook rejoué traité une fois (J29, J35, J40) |
| C3 | E/I | Webhook attribué au mauvais tenant via un champ libre du payload | Tenant déduit de `integrations (provider, external_account_id)` ou de nos `messages` ; jamais d'un champ libre | Compte inconnu ignoré (J29) ; test avec payload contenant un faux `organization_id` |
| C4 | D | Payload énorme ou rafale de webhooks | Limite de taille (3 Mo WhatsApp), ACK 200 rapide, traitement différé, rate limit | Test payload trop gros (J29) |
| C5 | R | Webhook accepté mais non traçable | `webhook_events` conservé (statut, signature_valid) ; logs sans payload sensible | Test de journalisation (J29) |
| C6 | T | Mise à jour hors ordre d'un statut (read avant delivered) | Machine d'états de statut monotone | Test statuts hors ordre (J35) |
| C7 | D | Fournisseur en panne (503) provoque doublon ou perte | Retry avec backoff, `idempotency_key`, lease | Test 503 ×2 puis 200 sans doublon (J40) |
| C8 | S | Reprise de l'app Salla : refresh token réutilisé → invalidation | Mutex par (organisation, boutique), mise à jour atomique du `secret_ref` | Test de concurrence refresh (J55, si option retenue) |

### D. Secrets et jetons (invariant 12)
| ID | STRIDE | Menace | Contrôle | Test (jour) |
|---|---|---|---|---|
| D1 | I | Jeton ou secret lisible via la Data API ou l'UI | `private.secrets` hors Data API, aucun renvoi au navigateur, UI en écriture seule (ADR 004) | Lecture via Data API impossible ; Company Admin ne lit rien (J28) |
| D2 | I | Secret dans les logs ou `audit_logs` | Redaction pino + `audit()` ; liste de champs masqués | Test de caviardage ; recherche automatisée de fuites dans les logs de test (J12, J41) |
| D3 | I | `service_role` ou clé dans le bundle client / `NEXT_PUBLIC_*` | Garde-fou CI sur `.next/static` et variables publiques | Fuite volontaire détectée (J5) |
| D4 | I | Rejeu d'un secret chiffré d'une entreprise dans une autre | AAD = `organization_id`+`secret_id` | Test d'AAD (J28) |
| D5 | I | Clé maîtresse perdue ou compromise | Clés versionnées, rotation, runbook | Rotation testée (J28, J58) |
| D6 | I | Secret poussé dans git | `.gitignore` (`.env*`), scan de secrets en CI | Test CI scan (J4–J5) |

### E. IA et injection de prompt (critère §13-8)
| ID | STRIDE | Menace | Contrôle | Test (jour) |
|---|---|---|---|---|
| E1 | E | Un message entrant contient « envoie ceci / change l'étape / donne les données de l'entreprise X » | Contenu client délimité et traité comme non fiable ; **agents sans outil de mutation** ; envoi seulement humain | Suite d'injection AR/FR/EN (J49–J50) |
| E2 | I | Fuite de contexte inter-tenant ou de secrets via le prompt | Contexte minimal filtré par organisation/projet, sans secret | Test d'isolation du contexte (J47) |
| E3 | T | Brouillon IA marqué `approved` ou envoyé seul | Brouillon créé en `draft` ; transitions de campagne ; `assertCanSend` exige approbation | Brouillon jamais `approved` (J48) ; test d'envoi sans approbation (J31) |
| E4 | D | Coût IA non maîtrisé (boucle, abus) | Budget et timeout par organisation ; `agent_runs` | Test de dépassement de budget (J47) |
| E5 | I | Données clients réelles envoyées à un fournisseur avant accord | Bascule `AI_ALLOW_REAL_DATA=false` ; données de test seulement (ADR 012) | Test de la bascule (J47) |
| E6 | T | Qualification qui rejette automatiquement un lead | Suggestion seulement, jamais de changement d'étape | Test J49 |

### F. Envoi non consenti et réputation (critères §13-5, §13-6, §13-7)
| ID | STRIDE | Menace | Contrôle | Test (jour) |
|---|---|---|---|---|
| F1 | T | Envoi à un contact sans consentement ou `do_not_contact` | Chaîne `assertCanSend` exécutée **dans le worker juste avant l'appel fournisseur** | Tests négatifs par contrôle (J31, J36) |
| F2 | R | Envoi après désabonnement en cours de campagne | `revokeConsent()` met à jour consentement + `do_not_contact` et annule les jobs en attente | T3 (J33, J40) |
| F3 | T | WhatsApp initié hors fenêtre sans template approuvé | Contrôle de fenêtre + template `APPROVED` | Message bloqué (J36) |
| F4 | T | Modification d'une campagne approuvée puis envoi sans revue | Retour en `pending_approval` à toute modification ; version et diff | Test J44 ; E2E J53 |
| F5 | D | Double envoi (retry, course pause/envoi, fan-out rejoué) | `idempotency_key` par message, lease, transactions de pause/arrêt | Fan-out rejoué, arrêt à mi-parcours (J45) |
| F6 | D | Emballement d'envois (bug, compromission) | Arrêt d'urgence par organisation/canal vérifié dans `assertCanSend` ; rate limit par fournisseur | Arrêt en moins d'un cycle de worker (J39) |
| F7 | I | Rebonds/plaintes ignorés dégradant la réputation | Table `suppressions` ; bounce dur et plainte → blocage | J32 |
| F8 | T | Dérive d'approbation : l'auteur s'approuve seul | Politique `four_eyes` (ADR 014) | Test d'auto-approbation (J44) |

### G. Exploitation, disponibilité, traçabilité
| ID | STRIDE | Menace | Contrôle | Test (jour) |
|---|---|---|---|---|
| G1 | R | Modification ou suppression d'`audit_logs` | `REVOKE UPDATE/DELETE` + trigger de refus | UPDATE sur audit échoue (J12) |
| G2 | R | Action sensible non journalisée (membres, intégrations, approbations, exports, support, suppressions) | `audit()` appelé par `withService` ; liste d'actions obligatoires | Tests par action (J12, J24, J44, J56) ; reconstitution C4 (J53) |
| G3 | D | File de jobs bloquée, job empoisonné | Lease + heartbeat, `dead_letter`, alertes | Deux workers, N échecs (J13) ; alerte dead letter (J58) |
| G4 | D | Perte de données, restauration impossible | Sauvegardes, exercice de restauration chronométré, secrets portables (ADR 004) | Restauration exécutée (J59) |
| G5 | D | Upload malveillant ou volumineux | Taille et magic bytes, types autorisés, Storage privé | Tests d'upload (J23, J57) |
| G6 | T | Dépendance vulnérable | `pnpm audit`, scan CI, versions épinglées | Aucune vulnérabilité haute/critique ouverte (J57) |
| G7 | D | Contournement des quotas par appels concurrents | Incrément atomique, `assertWithinLimit` dans le service | Test concurrent (J14) |
| G8 | I | Fuite de PII par les logs d'erreur / monitoring | Redaction ; pas de corps de message dans les logs ; monitoring configuré sans payloads | Recherche de fuites (J41, J58) |

## 3. Risques résiduels et hypothèses
- Postmark/Resend et la signature des webhooks e-mail : si le fournisseur n'a pas de signature HMAC, le contrôle C1 repose sur un secret de canal (Basic Auth/jeton d'URL), plus faible ; décision à acter (ADR 008).
- Données de test seulement pour l'IA : la protection E5 dépend de la discipline d'environnement ; la bascule est vérifiée en CI.
- Résidence des données non résolue (Q5/ADR 010) : risque légal, pas technique.
- Les figures 1–14 de la spec n'étant pas disponibles, des flux n'ont peut-être pas été modélisés (G-X1).

## 4. Revue
Revue du modèle à chaque checkpoint (C1–C4) et au durcissement J57 : chaque menace est revérifiée et son test confirmé vert.
