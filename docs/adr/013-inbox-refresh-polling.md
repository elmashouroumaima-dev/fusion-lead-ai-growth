# ADR 013 — Actualisation de la boîte de réception : polling, sans Realtime

- **Statut :** Proposed (2026-11-14, à valider par la responsable technique). Cité par le plan (J37) et le modèle de menaces (A5) mais jamais rédigé jusqu'ici.
- Date : 2026-11-14
- Sources : spec §5.5 (boîte de réception), §11 (isolation) ; ADR 005 (multi-entreprise, décision 13), ADR 007 (E4 `conversations`, `messages`), ADR 014 (RBAC) ; modèle de menaces A5 (« fuite par … temps réel »).

## Contexte
La boîte de réception (J37) doit montrer les nouveaux messages sans que l'utilisateur recharge la page. Le plan laisse le choix : « Realtime avec RLS ou polling ». Contrainte non négociable : **aucune fuite entre entreprises** (spec §13-1, menace A5), et les droits de lecture des conversations dépendent du rôle (owner et admin tout, le commercial SES conversations, marketing et analyste rien).

## Options
1. **Supabase Realtime (Postgres Changes) sous RLS.** Les événements sont filtrés par la RLS de l'abonné, mais : la table doit être ajoutée à la publication, la RLS de `messages` appelle `private.can_read_conversation` par ligne (coût et cas limites des politiques à fonction), le jeton du navigateur doit rester valide pendant la connexion (une adhésion retirée continue de recevoir tant que le jeton vit), et une erreur de publication ou de politique se traduit par une fuite silencieuse, détectable seulement par un test inter-entreprise spécifique. Il faudrait aussi exposer un second canal d'accès aux données (le WebSocket) à auditer et à tester.
2. **Polling du serveur.** La page (liste ou fil) se redessine toutes les 15 secondes **par le même chemin que le chargement initial** : composant serveur, client serveur de l'utilisateur, RLS de l'appelant, contexte d'organisation relu en base à chaque requête.

## Décision
**Polling** (option 2), sans Realtime pour le MVP.
- Un composant client `AutoRefresh` appelle `router.refresh()` toutes les **15 s**, **seulement quand l'onglet est visible** (`visibilitychange`), avec un rafraîchissement immédiat au retour dans l'onglet.
- **Aucun endpoint nouveau** : l'actualisation re-rend la page serveur existante ; elle ne contient aucune donnée que la page n'aurait pas déjà le droit d'afficher. Une adhésion retirée ou un rôle rétrogradé prend effet au rafraîchissement suivant (au plus 15 s), car le contexte est relu en base à chaque requête.
- Pas d'indicateur « non lu » en temps réel ni de son ; hors périmètre.

## Conséquences
- **Sécurité** : une seule surface d'accès aux données (le rendu serveur), déjà couverte par les tests d'isolation ; rien à ajouter à la publication Realtime. La menace A5 est traitée par construction.
- **Coût** : une requête de liste (ou de fil) toutes les 15 s par onglet visible ; faible avec la pagination (25 conversations, 50 messages) et les index existants. Le plafond de débit de la couche web s'applique.
- **Latence** : jusqu'à 15 s avant l'apparition d'un message. Acceptable pour le MVP (les canaux e-mail et WhatsApp ne sont pas instantanés pour le client non plus).
- **Évolution** : si la latence devient un sujet (pilote, J59), Realtime pourra être ajouté **par-dessus** (notification « il y a du nouveau » sans charge utile, puis `router.refresh()`), ce qui garde le rendu serveur comme seule source de données.

## À confirmer par la responsable technique
- Intervalle de 15 s.
- Réserve Realtime pour plus tard comme « simple signal », sans charge utile.
