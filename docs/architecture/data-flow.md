# Flux de données — Fusion Leap AI Growth

Sources : spec §6, §8, §9.1–§9.5, §10, §11. Les noms de routes sont des exemples de la spec (§8).

## 1. Vue d'ensemble
```mermaid
flowchart LR
  subgraph Browser
    UI[UI Next.js AR/EN]
  end
  subgraph Web[apps/web]
    API[API routes withService]
    WH[/api/webhooks/provider/]
    SSR[Session SSR]
  end
  subgraph Supabase
    AUTH[Auth]
    DB[(Postgres + RLS)]
    ST[(Storage privé)]
  end
  subgraph Worker[apps/worker]
    RUN[Claim jobs SKIP LOCKED]
    H[Handlers typés par kind]
  end
  subgraph Providers
    MAIL[Fournisseur e-mail]
    WA[WhatsApp Cloud API]
    CRM[Adaptateur CRM]
    SAL[Salla - marketing / option]
    AI[Fournisseur IA]
  end
  UI --> SSR --> AUTH
  UI --> API --> DB
  UI --> ST
  API -->|enqueue transactionnel| DB
  RUN --> DB
  RUN --> H
  H -->|assertCanSend puis send| MAIL
  H --> WA
  H --> CRM
  H --> AI
  MAIL -->|événements| WH
  WA -->|messages / statuts| WH
  SAL -.->|app.installed ...| WH
  WH -->|signature, tenant par compte, insert idempotent| DB
  WH -->|ACK 200 rapide| MAIL
```

## 2. Capture d'un lead (§9.1)
```mermaid
sequenceDiagram
  participant F as Formulaire du site
  participant A as POST /api/leads
  participant D as Postgres
  participant W as Worker
  F->>A: email/tél, projet, UTM, consentement (+ clé de formulaire)
  A->>A: clé -> organisation, origine, rate limit, honeypot, zod
  A->>D: transaction: upsert contact (même org), lead, consent_event, job assign_lead
  A-->>F: résultat (créé / dédupliqué)
  W->>D: claim assign_lead
  W->>D: règle d'assignation (round-robin / fixe) ou file non assignée + alerte
  W->>D: job crm_sync (mapping + external_id)
```

## 3. Envoi sortant et contrôle final (§9.2, §9.3, §5.7)
```mermaid
flowchart TD
  A[Réponse / campagne approuvée] --> B[message queued + job send_message]
  B --> C[Worker relit l'état en base]
  C --> D{approbation présente ?}
  D -- non --> X[bloqué]
  D -- oui --> E{consentement + finalité ?}
  E -- non --> X
  E -- oui --> F{do_not_contact / suppression ?}
  F -- oui --> X
  F -- non --> G{template approuvé si hors fenêtre ?}
  G -- non --> X
  G -- oui --> H{limites de débit / quota / send_paused ?}
  H -- non --> R[reporter / bloquer]
  H -- oui --> I[Contrôle final puis appel fournisseur]
  I --> J[provider_message_id + status accepted]
  J --> K[statuts delivered / bounced / read via webhook]
```

## 4. Webhook entrant (§8, §11)
```mermaid
flowchart TD
  P[POST /api/webhooks/provider] --> S{taille <= max ?}
  S -- non --> R1[413 + journal]
  S -- oui --> V{signature / secret valide ?}
  V -- non --> R2[401 + journal sans payload]
  V -- oui --> T[tenant = compte fournisseur dans integrations]
  T -- inconnu --> R3[202 ignoré + alerte]
  T -- trouvé --> I[insert webhook_events unique provider,event_id]
  I -- doublon --> OK[200 sans traitement]
  I -- nouveau --> J[job process_webhook] --> OK2[200 rapide]
```

## 5. Cycle de vie d'une campagne (§10)
`draft → pending_approval → approved → scheduled → running → completed` (+ `paused`, `rejected`, `failed`). Approbation : gel du `segment_snapshot` ; planification : job `campaign_fanout` par lots ; chaque message : `campaign_id`, `segment_snapshot_id`, `idempotency_key` ; toute modification après approbation → `pending_approval`.

## 6. Agents IA (§9.5)
Contexte minimal (fonctions de lecture filtrées par organisation/projet) → `AiAdapter` → brouillon enregistré en `draft` + `agent_runs` ; aucune écriture externe ; envoi seulement par un humain via le chemin 3.

## 7. Frontières de confiance
| Frontière | Contrôle |
|---|---|
| Navigateur → API | session SSR + adhésion revérifiée à chaque requête (ADR 005) |
| Navigateur → base (Data API) | RLS par opération ; pas de `service_role` |
| Fournisseur → webhook | signature/secret, taille, dédup, tenant par compte fournisseur |
| Worker → fournisseur | `service_role` + `organization_id` explicite + contrôle final |
| Contenu client → IA | délimité, non fiable, aucun outil de mutation |
| Secrets | `private.secrets` chiffré (ADR 004), jamais renvoyé au navigateur |
