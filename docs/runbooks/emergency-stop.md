# Arrêt d'urgence d'envoi (J39)

## Quand l'utiliser
Un envoi part en boucle, un compte fournisseur est compromis, un message erroné a été approuvé, ou une plainte arrive : on arrête **tout** l'envoi de l'entreprise, puis on enquête. Rien d'autre n'est modifié (les conversations, les contacts et les jobs restent en place).

## Qui peut le faire (ADR 014 ligne 9)
**Arrêter** : owner, admin, marketing manager. **Reprendre** : owner et admin seulement (la reprise est le sens risqué ; le marketing ne peut pas lever un arrêt posé par un owner). Pas le commercial ni l'analyste.

## Comment
1. **Interface** : menu **Operations** (Exploitation) → carte « Emergency stop » → **Stop all sending** → confirmer. Pour reprendre (owner ou admin) : **Resume sending** (sans confirmation) ; un responsable marketing voit un message l'indiquant.
2. **API** : `POST /api/send/emergency-stop` avec `{ "paused": true }` (ou `false`) et l'en-tête `Idempotency-Key`. Voir `docs/api/send-operations.md`.
3. **Par canal seulement** : page Intégrations (pause d'un canal), inchangée depuis le J28.

## Ce qui se passe
- L'arrêt pose `organizations.settings.send_paused = true` et écrit `send.emergency_stop` dans `audit_logs` (acteur, avant, après ; aucun contenu).
- Le worker relit ce drapeau **à chaque envoi** (`message_send_claim` → `assertCanSend`) : l'envoi est refusé avec `organization_paused`. Les envois déjà remis au fournisseur ne peuvent pas être rappelés ; tout envoi non encore tenté s'arrête au prochain cycle du worker (moins d'un cycle).
- Les messages refusés ne sont pas perdus : ils restent en file ou passent en échec selon la raison, et se retrouvent après reprise (vérifier la page Exploitation).

## Après l'incident
1. Vérifier les dead letters (page Exploitation) et les alertes « send.failed » reçues par owner et admin.
2. Reprendre les envois (**Resume sending**) seulement quand la cause est traitée.
3. Rejouer les jobs en échec utiles un par un (bouton **Replay**, owner et admin).

## Vérifier en base (si l'interface est indisponible)
```sql
select id, settings ->> 'send_paused' as send_paused from public.organizations where id = '<organization_id>';
select created_at, action, actor_id from public.audit_logs where organization_id = '<organization_id>' and action = 'send.emergency_stop' order by created_at desc limit 5;
```

## Limites connues
- Un envoi déjà accepté par le fournisseur ne peut pas être annulé.
- L'arrêt est **par entreprise** (et par canal via les Intégrations) ; il n'existe pas d'arrêt global de plateforme dans ce jour.
- Le délai « moins d'un cycle de worker » suppose un worker en marche ; si le worker est arrêté, rien ne part de toute façon.
