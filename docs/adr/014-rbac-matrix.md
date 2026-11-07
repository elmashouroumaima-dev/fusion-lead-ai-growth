# ADR 014 — Matrice des rôles (RBAC)

- **Statut :** Proposed — **validation de la responsable technique requise** (comble G-R1, G-R2, G-R3 ; la spec ne donne pas de matrice complète)
- **Date :** 2026-11-10
- **Section de spec :** §2 (rôles), §5.7, §10, §11, §13-2

## Contexte
La spec décrit les rôles en prose (§2) et fixe quatre contraintes testables (§13-2) : Analyst n'envoie pas ; Sales Agent ne modifie pas les intégrations ; Marketing Manager n'envoie qu'après approbation selon la politique ; Company Owner gère les adhésions. Toute autre case est une proposition ci-dessous, marquée **[P]**. Chaque cellule est implémentée **deux fois** : `packages/permissions` (`can(role, action, resource, ctx)`) et RLS.

Rôles d'organisation (enum `app_role`) : **OWN** company_owner · **ADM** company_admin · **MKT** marketing_manager · **SAL** sales_agent · **ANA** analyst. Le **Platform Admin** n'est pas un rôle d'organisation (voir ADR 005 §10) : il n'a aucun droit tenant hors session de support active.

Légende : ✔ autorisé · ✘ refusé · `own` = seulement les enregistrements qui lui sont assignés (`assignee_id = auth.uid()`) · `≠auteur` = l'approbateur ne peut pas être l'auteur.

## Matrice

| Ressource / action | OWN | ADM | MKT | SAL | ANA | Source |
|---|---|---|---|---|---|---|
| **Entreprise** : modifier réglages, marque, politique de consentement | ✔ | ✔ | ✘ | ✘ | ✘ | §2 ; ADM [P] |
| **Plan / facturation** : voir | ✔ | ✔ | ✘ | ✘ | ✘ | §2 [P] |
| **Membres** : lister | ✔ | ✔ | ✘ | ✘ | ✘ | §2 [P] |
| **Membres** : inviter / changer le rôle / retirer | ✔ | ✔ (jamais un OWN, ne peut pas attribuer OWN) | ✘ | ✘ | ✘ | §2, §13-2 |
| **Propriété** : transférer | ✔ | ✘ | ✘ | ✘ | ✘ | §2 |
| **Intégrations / canaux** : voir statut | ✔ | ✔ | ✘ | ✘ | ✘ | §2 [P] |
| **Intégrations / canaux** : connecter, remplacer un secret, déconnecter | ✔ | ✔ (canaux ; secrets en écriture seule) | ✘ | ✘ | ✘ | §2 ; SAL ✘ §13-2 |
| **Secrets bruts** : lire | ✘ | ✘ | ✘ | ✘ | ✘ | §2, §11 (G-R3) |
| **Arrêt d'urgence d'envoi** (org / canal) | ✔ | ✔ | ✔ | ✘ | ✘ | §11 [P] |
| **Projets / produits** : lire | ✔ | ✔ | ✔ | ✔ | ✔ | §2 |
| **Projets / produits** : créer, modifier, archiver | ✔ | ✔ | ✘ | ✘ | ✘ | §2 [P] (MKT en lecture) |
| **Contacts / leads / deals** : lire | ✔ | ✔ | ✔ | `own` | ✘ (PII) | §2 ; ANA [P] |
| **Contacts / leads** : créer (manuel, import CSV) | ✔ | ✔ | ✔ | ✔ (assigné à soi) | ✘ | §5.3 [P] |
| **Leads / deals** : modifier, changer d'étape, tâches | ✔ | ✔ | ✘ | `own` | ✘ | §2 (SAL met à jour le deal) |
| **Leads non assignés** : voir / assigner | ✔ | ✔ | ✔ voir | ✘ | ✘ | §9.1 [P] |
| **Règles d'assignation, pipelines, mappings CRM** | ✔ | ✔ | ✘ | ✘ | ✘ | §5.3 [P] |
| **Conversations** : lire | ✔ | ✔ | ✘ | `own` | ✘ | §2 |
| **Conversations** : répondre (1:1) | ✔ | ✔ | ✘ | `own` | ✘ | §2, §13-2 |
| **Consentement** : révoquer / marquer do_not_contact | ✔ | ✔ | ✔ | `own` | ✘ | §9.3 [P] (toujours autorisé : bloque l'envoi) |
| **Campagnes** : lire | ✔ | ✔ | ✔ | ✘ | ✔ (résultats) | §2 [P] |
| **Campagnes / assets / segments** : créer, modifier, soumettre | ✔ | ✔ | ✔ | ✘ | ✘ | §2 |
| **Campagnes** : approuver | ✔ `≠auteur` | ✔ `≠auteur` | ✔ `≠auteur` | ✘ | ✘ | §2, §10 (G-R2) |
| **Campagnes** : planifier, mettre en pause / arrêter | ✔ | ✔ | ✔ (si `approved`) | ✘ | ✘ | §2, §13-2 |
| **Agents IA** : demander un brouillon / qualification | ✔ | ✔ | ✔ | ✔ (sur ses leads) | ✘ | §9.5 [P] |
| **Brouillon IA** : utiliser / envoyer après relecture | ✔ | ✔ | ✘ (campagne via approbation) | `own` | ✘ | §9.5 |
| **Analyst Agent / rapports / tableau de bord** : lire | ✔ | ✔ | ✔ | ✘ (ses propres leads seulement) | ✔ (agrégats) | §2 [P] |
| **Journal d'audit** : lire | ✔ | ✔ | ✘ | ✘ | ✘ | §11 [P] |
| **Exports de données** (CSV) | ✔ | ✔ | ✔ résultats de campagne | ✘ | ✘ | §11 [P], audit obligatoire |
| **Alertes / centre d'exploitation, dead letter** : voir | ✔ | ✔ | ✘ | ✘ | ✘ | §5.8 [P] ; rejeu : OWN, ADM |
| **Dead letter** : rejouer | ✔ | ✔ | ✘ | ✘ | ✘ | §6 [P] |
| **Suppression définitive d'enregistrements / de l'entreprise** | ✔ (entreprise) | ✔ (enregistrements) | ✘ | ✘ | ✘ | §11 [P], audit obligatoire |

## Règles de politique d'approbation (G-R2)
- Paramètre d'entreprise `approval_policy` (défaut `four_eyes`) : **l'approbateur est différent de l'auteur** de la dernière version du contenu.
- Si l'entreprise n'a qu'un seul membre habilité à approuver, l'auto-approbation est autorisée et marquée `self_approved` dans l'audit.
- **Envoi 1:1 (réponses inbox)** : l'« approbation » exigée au MVP (§5.7) est l'action explicite d'envoi d'un utilisateur habilité sur un texte humain ou un brouillon IA relu ; le contrôle final (consentement, `do_not_contact`, template, limites) reste exécuté par le worker.
- **Envoi de campagne** : exige l'état `approved` puis `scheduled` ; toute modification repasse en `pending_approval` (§10).

## Conséquences
- `packages/permissions` est généré/testé à partir de ce tableau (tests table-driven exhaustifs, J10).
- Les cases `[P]` sont des propositions : toute modification passe par une révision de cet ADR.
- ANA sans accès aux contacts (PII) est une lecture stricte de « données autorisées » (§2) ; à assouplir uniquement si le produit le demande.

## Mise en œuvre J7 (2026-11-06)
Cases de la matrice appliquées côté base (RLS) pour les tables du noyau : membres (lister : owner/admin, chacun voit sa propre ligne ; inviter/changer le rôle/retirer : owner, et admin hors owner), propriété (transfert : seul un owner peut promouvoir un autre owner ; dernier owner protégé), entreprise (modifier : owner/admin), plan/facturation (lire : owner/admin ; écrire : serveur). Les cases qui concernent des tables à venir (projets, CRM, campagnes…) seront appliquées avec leurs migrations. Le « changement de propriété » reste à exposer via une action serveur (J10).

## Mise en œuvre J10 (2026-11-06)
- **Implémentation** : `packages/permissions` contient `PERMISSION_MATRIX` (les 31 lignes du tableau ci-dessus), `can(role, action, resource, ctx?)`, `canManageMember` et `assignableRoles`. Tout rôle, action ou ressource inconnu est refusé. Un test lit ce tableau Markdown et compare chaque cellule ; un second test écrit à la main (oracle indépendant) tous les croisements rôle × action × contexte. Le type `Role` est comparé aux valeurs de l'enum SQL `app_role`.
- **Double application** : l'application vérifie `can()` avant tout accès à la base ; la base reste l'autorité (RLS, fonctions `security definer`, triggers `protect_last_owner` et d'anti-transfert).
- **Interprétations à valider par la responsable technique** (le tableau est ambigu ; elles sont commentées dans `matrix.ts`) :
  1. Ligne « Suppression définitive » : OWN peut supprimer l'entreprise et des enregistrements ; ADM seulement des enregistrements (pas l'entreprise).
  2. Ligne « Analyst Agent / rapports… » : Sales Agent « ses propres leads seulement » est appliqué comme **refus** tant que les agrégats par assigné n'existent pas.
  3. Ligne « Contacts / leads : créer » : « assigné à soi » pour SAL impose `ctx.isOwnRecord`.
  4. Ligne « Campagnes : planifier, pause/arrêt » : Marketing Manager seulement si `ctx.isApproved === true` (champ ajouté au contexte).
- **Membres** : la liste affiche le rôle, le statut et un identifiant court (les e-mails des membres ne sont pas lisibles sans `service_role`, interdit côté navigateur ; un profil affichable est à décider). Un utilisateur ne peut pas changer son propre rôle ni se retirer (garde anti-verrouillage) : l'ownership se transmet par `transfer_ownership`.
- **Invitations** : table `invitations` (ADR 007, G-R8), jeton aléatoire de 256 bits, **seul son hash sha256 est stocké** et il n'est pas lisible via l'API (GRANT de colonnes) ; validité 7 jours ; le lien est affiché une seule fois à l'inviteur (aucun e-mail envoyé avant J31–J33). `accept_invitation` exige que l'e-mail **confirmé** du compte soit celui de l'invitation et que l'inviteur soit toujours owner/admin actif ; toutes les causes d'échec renvoient la même erreur. Réinviter une adresse révoque l'invitation en attente et en crée une nouvelle (atomique). `already_member` révèle à owner/admin l'appartenance d'une adresse à **leur** organisation (accepté).
- **Écarts au plan** : migration modifiée sur place après revue de sécurité (jamais commitée ni appliquée hors base locale) ; la dépendance `@fusion-leap/permissions` a été déclarée dans `apps/web`.
- **Reste** : audit (J12), couche service et idempotence générique (J11), limitation de débit sur l'acceptation et plafond d'invitations en attente (J57), e-mails d'invitation (J31–J33).
