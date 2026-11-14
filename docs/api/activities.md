# Activités et chronologie (J20)

Migration `20261122100000_activities.sql` (retour arrière : `supabase/rollbacks/20261122100000_activities.sql`). Spec §3 et §7, ADR 007 (`activities`, E2), ADR 014. Pas d'écran au J20 (l'interface CRM vient au J24) : base, domaine et service sont livrés.

## Modèle
`activities` : `lead_id`, `contact_id` (celui du lead, vérifié par la base), `type`, `owner_id` (auteur, ou responsable d'une tâche), `due_at`, `completed_at`, `metadata`. Clés étrangères **composites** vers le lead, le contact et l'adhésion de l'auteur : tout reste dans la même entreprise. Toute activité vise un **lead** (le contact en est déduit).

**Types** : `note`, `call`, `email`, `task`, `meeting` (créés à la main) ; `stage_change`, `assignment` (écrits **par la base**, jamais à la main).

**Contenu** : pas de colonne texte dans l'ADR ; il vit dans `metadata`, validé par la base selon le type (clés connues seulement, 4 Ko au plus, aucun caractère de contrôle ni de direction) :

| Type | `metadata` | `due_at` |
|---|---|---|
| `note` | `text` (obligatoire, 2000 car. au plus) | non |
| `call` | `text` et / ou `outcome` (`answered`, `no_answer`, `voicemail`, `busy`, `wrong_number`), `duration_minutes` (0 à 600, entier) | non |
| `email` (compte rendu, **aucun envoi**) | `subject` (obligatoire, 200), `text` | non |
| `meeting` | `title` (obligatoire, 200), `text` | oui |
| `task` | `title` (obligatoire, 200), `text` | oui ; `completed_at` posé par la base |
| `stage_change` | `from_stage_id`, `to_stage_id`, `deal_id` (changement d'étape d'un deal) | non |
| `assignment` | `from_assignee_id`, `to_assignee_id` (null permis) | non |

Échéances entre 2000 et 2100.

## Journal automatique
Des déclencheurs écrivent, dans la **même transaction** :
- `stage_change` à chaque changement d'étape d'un **lead** ; `assignment` à chaque changement de responsable (assignation, retrait, **libération automatique** d'un membre suspendu, retiré ou rétrogradé) ;
- `stage_change` (avec `deal_id`) à chaque changement d'étape d'un **deal**.
L'auteur (`owner_id`) est l'acteur s'il est membre de l'entreprise, sinon vide (tâche système). La création d'un lead n'écrit pas d'entrée (la chronologie commence au premier changement).

## Règles
- **Historique fiable** : note, appel, e-mail, rendez-vous et entrées automatiques ne se modifient ni ne se suppriment jamais ; aucune suppression d'activité. Seule exception technique : la suppression de la **ligne d'un membre** efface le seul champ `owner_id` de ses entrées (le contenu reste intact).
- **Tâches** : seules à évoluer (titre, texte, échéance, responsable, fait / à refaire). Le responsable est l'auteur par défaut ; owner et admin peuvent la confier à un membre **assignable** (actif, owner, admin ou commercial) ; le commercial ne se l'attribue qu'à lui-même. **Un commercial n'est responsable d'une tâche que sur un lead dont il est lui-même responsable** (sinon il ne la verrait pas : `assignee_invalid`). Terminer deux fois ne change pas la date de fin ; rouvrir l'efface. À la modification, `due_at` est **obligatoire** (nul = retirer l'échéance) ; un responsable nul laisse le responsable inchangé.
- Un lead d'un **projet archivé** est en lecture seule ; **abonnement actif** exigé pour créer (`subscription_inactive`) ; plafonds techniques par lead : **500 activités manuelles** (`too_many_activities`) et **1000 entrées automatiques** (au-delà, plus d'entrée automatique : l'audit `lead.*` et `deal.*` garde la trace). Le contenu est validé **avant** l'insertion (aucune ligne fautive, texte compris, dans les journaux du serveur).

## Droits (ADR 014 : « Leads / deals : modifier, changer d'étape, tâches »)
| Action | owner | admin | marketing | commercial | analyste |
|---|---|---|---|---|---|
| Lire la chronologie | tous les leads | tous | tous | **ses leads** (`assignee_id = auth.uid()`) | non |
| Créer une activité, modifier / terminer une tâche | oui | oui | non | **sur ses leads** | non |

Aucune écriture directe sur la table, même pour `service_role`. Un lead d'un autre commercial est « introuvable » pour un commercial (comme avec la RLS).

## Fonctions SQL (surface PostgREST, `SECURITY DEFINER`, `search_path` vide, aucun droit pour `anon` ni `service_role`)
`create_activity(p_org, p_lead, p_type, p_metadata, p_due_at, p_owner)` · `update_task(p_org, p_id, p_metadata, p_due_at, p_owner)` (responsable nul = inchangé) · `complete_task(p_org, p_id, p_done)`.

Codes d'erreur : `28000` non authentifié · `42501` interdit · `22023` / `23514` valeur invalide · `PT404` introuvable · `P0001` : `project_archived`, `assignee_invalid`, `subscription_inactive`, `too_many_activities`.

## Service web (`apps/web/lib/activities`)
- Écritures : `createActivity`, `updateTask`, `completeTask` (résultat `{ ok, value | code }`, entreprise du **contexte vérifié**). `too_many_activities` et `project_archived` donnent `conflict`, `assignee_invalid` donne `validation_failed`, `subscription_inactive` donne `quota_exceeded`.
- Lectures avec les droits de l'utilisateur : `listTimeline` (la plus récente d'abord, pagination bornée), `listDueTasks` (tâches ouvertes dont l'échéance est atteinte, par responsable), `nextActionsFor` (**prochaine action** de 200 leads au plus en une lecture), `getActivity`.
- Domaine (`packages/domain/src/activities`) : schémas par type, `nextAction` (première tâche ouverte, échéance la plus proche, sans échéance en dernier), `isDue`, `dueTasks`, `sortTimeline`.
- **Statut, responsable, prochaine action** d'un lead (spec §3) = son étape (`leads.stage_id`), son responsable (`leads.assignee_id`) et `nextAction` de ses tâches.

## Audit
`activity.created` (lead, type), `activity.updated` (noms des champs), `activity.completed`, `activity.reopened`. **Jamais** le texte, le titre ni l'objet. Les changements d'étape et d'assignation sont déjà journalisés par `lead.*` et `deal.*` (pas de doublon).

## Fiche lead (J30c)
Page `/leads/[id]` (le nom du contact dans `/leads` en est le lien). **Rôles** : owner, admin et marketing lisent tous les leads, le commercial **les siens** (le lead d'un autre commercial, d'une autre entreprise ou un identifiant invalide donne 404 : RLS) ; l'analyste est renvoyé au tableau de bord (données personnelles).
- **Contenu** : résumé (étape, responsable, source, projet, date), contact (e-mail, téléphone ; lien vers la fiche contact pour owner, admin et marketing), **prochaine action** (`nextAction` : première tâche ouverte), deals du lead (lecture ; la création est J30d), **chronologie** (`listTimeline`, 50 entrées, la plus récente d'abord).
- **Chronologie** : notes, appels (résultat, durée), e-mails (comptes rendus), rendez-vous, tâches (échéance, faite le …) et les entrées **automatiques** écrites par la base (changement d'étape d'un lead ou d'un deal, changement de responsable), marquées « Automatique ». L'auteur est « Moi », « Membre 0000XX » ou « Système ».
- **Formulaires** (Server Actions, `withAction` : zod, contexte tenant relu en base, `organization_id` comparé, `can()` ADR 014 ligne 14 `leads` / `manage_tasks` accordé « own » aux commerciaux, limitation de débit, **clé d'idempotence obligatoire**) :
  - `activities.create` : note (texte obligatoire), appel (résultat, durée 0 à 600 min, texte), tâche (titre obligatoire, texte, échéance en **date** enregistrée à midi UTC). L'e-mail, le rendez-vous, l'étape et l'assignation ne sont **pas** proposés (rejetés par le schéma) ;
  - `activities.task.complete` : marquer une tâche faite ou à refaire.
  Visibles pour owner, admin et le commercial sur son lead ; **jamais pour le marketing** (lecture seule). La base refuse tout autre lead (`create_activity`, `complete_task` relisent le rôle et la propriété), un projet archivé et un abonnement inactif.
- **Contenu saisi** : affiché seulement ici, aux rôles qui lisent le lead ; l'audit (`activity.created`, `activity.completed`) ne garde que le type et le lead, **jamais** le texte, le titre ni l'objet.
- Aucune migration, aucune route REST ajoutée (Server Actions, comme les écrans Projets et Contacts).

## Limites connues
- **Auteur après suppression d'un membre** : la ligne du membre supprimée, `owner_id` de ses entrées devient vide (elles ressemblent alors à une entrée système) ; `audit_logs` (`activity.created`) conserve l'auteur.
- **Lecture par le marketing** : le marketing lit toutes les activités (notes, comptes rendus d'appel et d'e-mail), comme les leads ; l'ADR 014 n'a pas de ligne « activités » : à confirmer avec la responsable technique.
- **Journaux Postgres** : une violation d'unicité ou de contrainte écrit la valeur fautive dans le journal du serveur ; le contenu des activités est validé avant l'écriture, mais `log_error_verbosity = terse` reste recommandé en production (ADR 010).
- **Débit** : basculer une tâche faite / à refaire en boucle écrit une entrée d'audit à chaque appel ; la limitation de débit est celle de la couche web (routes et Server Actions).
- **Verrous** : supprimer la ligne d'un membre pendant qu'on crée une tâche peut, rarement, provoquer un interblocage détecté par Postgres (`40P01`, aucune corruption) : à rejouer.
- Pas de clé d'idempotence dans le service : elle sera exigée au niveau des routes et Server Actions (une note rejouée créerait un doublon).
- Pas d'activité sans lead (appel à un contact sans lead) ; pas de rappels ni de notifications d'échéance (le worker viendra avec les canaux) ; `meeting_booked` (`domain_events`, G-D6) arrive avec le tableau de bord.
