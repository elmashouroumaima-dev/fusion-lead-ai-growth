# Assignation automatique des leads (J22)

Migration `20261124100000_assignment.sql` (retour arrière : `supabase/rollbacks/20261124100000_assignment.sql`). Spec §9.1 étape 4, ADR 007 (`assignment_rules`, `notifications`), ADR 014 (leads non assignés). Pas d'écran (J24).

## Principe
La capture publique (J21) crée le lead dans l'étape « non assigné » et enregistre un job `lead.assign` `{ lead_id }`. Le **worker** le traite : il appelle `auto_assign_lead(entreprise du JOB, lead)`, qui choisit le responsable selon la règle. Aucun membre possible : le lead **reste** dans la file « non assignés » et les owner et admin sont alertés. Rien n'est envoyé au client (aucun envoi externe).

## Règles d'assignation (`assignment_rules`)
| Champ | Sens |
|---|---|
| `project_id` | projet visé ; **nul = règle par défaut de l'entreprise** |
| `strategy` | `round_robin` (chacun son tour) ou `fixed` (un seul membre) |
| `eligible_member_ids` | 1 à 50 membres (identifiants d'utilisateur), sans doublon ; `fixed` = exactement 1 |
| `cursor` | position du prochain membre (round-robin), remis à zéro à chaque modification |
| `active` | une règle inactive est ignorée |

- La règle **du projet** du lead prime ; sinon la règle par défaut ; sinon aucune règle.
- **Une seule règle active** par projet et **une seule** par défaut ; 50 règles au plus par entreprise.
- Chaque membre doit être **assignable** à l'écriture (actif, owner / admin / commercial, de CETTE entreprise) ; il est revérifié à **chaque** assignation (un membre suspendu, retiré ou rétrogradé est sauté).
- Fonctions (owner et admin seulement, avec leur session, `SECURITY DEFINER`) : `create_assignment_rule(p_org, p_project, p_strategy, p_members)` → id, `update_assignment_rule(p_org, p_id, p_strategy, p_members, p_active)`, `delete_assignment_rule(p_org, p_id)`. Lecture : owner et admin (RLS). Aucune écriture directe, pas même `service_role`.
- Erreurs : 403 `forbidden`, 400 `validation_failed` (doublons, stratégie, membre non assignable), 404 `not_found` (projet ou règle d'une autre entreprise), 409 `conflict` (règle déjà active, plafond), `project_archived`.

## `auto_assign_lead(p_org, p_lead)` (service_role : worker)
Retour `{ outcome, reason?, assignee_id? }` :
| outcome | Cas |
|---|---|
| `assigned` | membre choisi ; le lead passe à la première étape **ouverte** du pipeline |
| `unassigned` | `no_rule`, `no_eligible` (aucun membre éligible actif) ou `failed` (pipeline sans étape ouverte) : le lead reste dans la file, alerte aux admins |
| `skipped` | `not_found` (lead absent **de cette entreprise**), `not_unassigned` (déjà assigné ou plus dans la file : **rejeu sans double assignation**), `project_archived` |

- Le lead est **verrouillé**, puis la règle ; le curseur du round-robin avance atomiquement (deux jobs simultanés ne choisissent pas le même rang).
- Journal de la chronologie : une entrée `assignment` (acteur système). Audit : `lead.auto_assigned` (identifiant de la règle et du responsable seulement).

## Alertes (`notifications`)
- Une ligne **par destinataire** (owner et admin actifs) : `kind = lead.unassigned`, `payload = { lead_id, reason }` (`no_rule`, `no_eligible`, `failed`), jamais de nom, d'e-mail ni de téléphone.
- **Déduplication** par lead et destinataire : un job rejoué ne notifie pas deux fois. Plafond technique : 10 000 notifications par entreprise ; au-delà, les notifications **déjà lues** les plus anciennes sont évincées (1000 à la fois) ; si aucune n'est lue, l'alerte n'est pas créée (le lead reste visible dans la file).
- Lecture : le **destinataire seulement** (RLS) ; `mark_notification_read(p_org, p_id)` pose `read_at` (le destinataire seulement, sinon 404).
- Le marketing et les commerciaux ne reçoivent pas ces alertes.

## Worker
`apps/worker/src/handlers.ts` : handler `lead.assign`, charge utile `{ lead_id }` stricte, **l'entreprise vient de la ligne du job**. Erreur technique : le job est réessayé ; à la **dernière tentative**, le worker appelle `flag_lead_unassigned` (alerte `failed`, seulement pour un lead de l'entreprise encore non assigné) puis laisse le job échouer. Seuls des codes d'erreur sont enregistrés.

## Service web (`apps/web/lib/assignment/service.ts`)
`listAssignmentRules`, `createAssignmentRule`, `updateAssignmentRule`, `deleteAssignmentRule`, `listUnassignedLeads` (file « non assignés », plus ancien d'abord, 100 au plus + total ; lecture RLS : owner, admin, marketing), `listNotifications`, `markNotificationRead`. Client serveur de l'utilisateur (RLS), entreprise du contexte vérifié.

## Revue sécurité adverse (0 bloquant, 2 moyens, 7 faibles)
Corrigés : plafond de notifications avec évincement des lues (au lieu de perdre les alertes pour toujours) ; plafond de 50 règles sérialisé par entreprise ; réactivation d'une règle refusée si l'abonnement est suspendu ; tableau à deux dimensions ou avec NULL refusé en `validation_failed` ; curseur conservé quand seul l'état change ; motif `failed` cohérent entre le retour et l'alerte.
Documentés (voir « Limites connues » et les décisions de la responsable technique) : leads libérés, projet archivé, membre ré-ajouté, timeout du worker, abonnement des jobs en vol.

## Limites connues
- **Leads libérés** (membre suspendu, supprimé ou rétrogradé, J19) : ils retournent dans la file « non assignés » **sans nouveau job ni alerte** ; de même, créer ou activer une règle après coup ne balaie pas la file. À décider : job `lead.assign` à la libération (clé d'idempotence à revoir) et/ou balayage périodique.
- **Projet archivé entre la capture et le job** : le lead est ignoré sans alerte et n'est pas retraité à la réactivation du projet.
- **Membre supprimé puis ré-ajouté** (ou rétrogradé puis promu) : son identifiant reste dans la règle (tableau sans clé étrangère) et il reçoit de nouveau des leads sans reconfirmation. Retirer le membre des règles à sa suppression est à décider.
- **Délai dépassé du handler ou bail expiré** (worker mort) : pas d'alerte `failed` (le job passe en `dead_letter`, visible au centre d'exploitation) ; un balayage périodique réglerait aussi ce cas.
- `auto_assign_lead` ne vérifie pas l'abonnement : les jobs déjà en file d'une entreprise suspendue sont encore traités (à confirmer).
- Un ancien admin rétrogradé garde la lecture de ses anciennes alertes (identifiants et motif seulement).
- Pas de pondération, de capacité maximale ni de disponibilité : le round-robin ne regarde que l'état « actif » du membre.
- Un lead créé à la main (J19) ne passe pas par la règle (la spec ne le prévoit que pour la capture) ; l'assignation manuelle reste possible.
- `eligible_member_ids` est un tableau (ADR 007) : pas de clé étrangère ; la validité est contrôlée à l'écriture et à chaque assignation.
- Les jobs `lead.assign` déjà échus avant ce déploiement étaient traités par un handler sans effet : leurs leads restent dans la file « non assignés » et se règlent à la main.
- Aucune relance automatique d'un lead resté dans la file (à décider avec l'écran de la file, J24).
- L'alerte n'existe qu'in-app ; aucune notification e-mail (J31–33).
