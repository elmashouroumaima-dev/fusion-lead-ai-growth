# Tests fonctionnels — Phase 1 (J4 à J15)

Guide pour la personne qui teste (stagiaire, recette). Il couvre l'application telle qu'elle est après la Phase 1 : accès, organisations, membres, rôles, plans et quotas, Paramétrage, isolation entre entreprises. Aucune connaissance du code n'est nécessaire pour les parties A à K ; les parties L et M sont techniques (base de données, worker).

- **Durée estimée** : 3 à 4 heures.
- **Règle d'or** : pour chaque cas, noter **OK** ou **KO** dans la colonne de résultat (§ « Fiche de résultats »). En cas de **KO**, remplir une fiche d'anomalie (§ « Signaler une anomalie ») avec une capture d'écran.
- **Données** : uniquement des données de test. Ne jamais utiliser de vraies adresses clients.

---

## 0. Préparation (une seule fois)

1. Suivre `start-fusion-lead-ai-growth.md` (à la racine) : installation, variables d'environnement, base locale.
2. Démarrer et préparer :
   ```bash
   pnpm db:start
   pnpm db:reset
   pnpm dev
   ```
   `pnpm db:reset` remet la base à l'état de départ (les 7 comptes ci-dessous et 2 entreprises). À refaire si des données de test sont abîmées.
3. Ouvrir **un seul** navigateur à l'adresse `http://localhost:3000` (ne jamais mélanger `localhost` et `127.0.0.1` : les sessions sont séparées).
4. Boîte d'e-mails de test : **Mailtrap** (compte du projet, boîte « Email Testing »). Tous les e-mails de l'application y arrivent, quel que soit le destinataire.
5. Pour tester deux utilisateurs en même temps, utiliser **une fenêtre de navigation privée** pour le second.

### Comptes de test
Mot de passe de développement (le même pour tous) : constante `dev_password` au début de `supabase/seed.sql`.

| Adresse | Rôle | Entreprise(s) | Administration de la plateforme |
|---|---|---|---|
| `shared@seed.test` | Propriétaire (Alpha) et Commercial (Beta) | Alpha, Beta | **oui** |
| `alpha-admin@seed.test` | Administrateur | Alpha | non |
| `alpha-marketing@seed.test` | Responsable marketing | Alpha | non |
| `alpha-sales@seed.test` | Commercial | Alpha | non |
| `alpha-analyst@seed.test` | Analyste | Alpha | non |
| `beta-owner@seed.test` | Propriétaire | Beta | non |
| `beta-analyst@seed.test` | Analyste | Beta | non |

Langues : français (par défaut), arabe (de droite à gauche), anglais.

---

## A. Accueil, connexion, inscription (J8)

| ID | Étapes | Résultat attendu |
|---|---|---|
| A1 | Ouvrir `http://localhost:3000/fr`. | Page d'accueil avec le logo FUSION LEAP, le titre, les boutons **Se connecter** et **Créer un compte**, et le pied de page « © … Tous droits réservés. ». |
| A2 | Cliquer **Se connecter**. Saisir `alpha-admin@seed.test` et un **mauvais** mot de passe. | Notification rouge en haut + message « Adresse e-mail ou mot de passe incorrect ». Pas de connexion. |
| A3 | Se connecter avec le bon mot de passe. | Redirection vers **Tableau de bord**. L'adresse connectée apparaît dans le menu du compte (en haut à droite). |
| A4 | Se déconnecter (menu du compte → **Se déconnecter**). Taper directement `http://localhost:3000/fr/members`. | Redirection vers la page de connexion. Après connexion, retour à la page demandée. |
| A5 | Page **Créer un compte** : saisir une adresse **nouvelle** (ex. `testeur1@seed.test`) et un mot de passe robuste, valider. | Message de succès. Un e-mail de confirmation arrive dans **Mailtrap** (voir K1). |
| A6 | Cliquer le lien de confirmation de l'e-mail, puis se connecter avec ce compte. | Connexion réussie. Comme le compte n'a pas d'entreprise : page **Créer votre organisation** (B1). |
| A7 | Page de connexion → **Mot de passe oublié ?** : saisir `alpha-analyst@seed.test`. | Message générique de succès. E-mail de réinitialisation dans Mailtrap. Le lien ouvre la page de nouveau mot de passe ; après changement, connexion possible avec le nouveau mot de passe. **Remettre ensuite le mot de passe d'origine** ou lancer `pnpm db:reset`. |
| A8 | Saisir une adresse qui n'existe pas dans « Mot de passe oublié ». | Même message de succès (pas de fuite sur l'existence du compte). |

## B. Organisations et sélecteur (J9)

| ID | Étapes | Résultat attendu |
|---|---|---|
| B1 | Avec le compte créé en A6 : remplir **Nom de l'organisation**, **Fuseau horaire**, **Langue par défaut**, valider **Créer l'organisation**. | Redirection vers le tableau de bord. Le rôle affiché est **Propriétaire**. |
| B2 | Cliquer deux fois rapidement sur **Créer l'organisation** (nouveau compte si besoin). | **Une seule** organisation est créée (pas de doublon). |
| B3 | Se connecter avec `shared@seed.test`. | Page **Choisir une organisation** avec Alpha et Beta. |
| B4 | Ouvrir Alpha, puis utiliser le sélecteur d'organisation (en haut) pour passer à Beta. | Le nom de l'organisation du fil d'Ariane et le **rôle** changent (Propriétaire dans Alpha, Commercial dans Beta). |
| B5 | Avec `alpha-admin@seed.test` (une seule entreprise). | Pas de sélecteur d'organisation, tableau de bord d'Alpha directement. |

## C. Rôles et droits (J10, critère §13-2)

Pour chaque compte, se connecter puis noter ce que le **menu latéral** propose et ce qui se passe en tapant l'adresse directement.

| ID | Compte | Menu attendu | Adresse tapée à la main | Résultat attendu |
|---|---|---|---|---|
| C1 | `shared@seed.test` (Alpha) | Tableau de bord, Membres, Paramétrage, **Administration** | `/fr/members` | Page Membres affichée |
| C2 | `alpha-admin@seed.test` | Tableau de bord, Membres, Paramétrage ; **pas d'Administration** | `/fr/admin/organizations` | Retour au tableau de bord |
| C3 | `alpha-marketing@seed.test` | **Ni Membres ni Paramétrage ni Administration** | `/fr/members` | Retour au tableau de bord |
| C4 | `alpha-sales@seed.test` | Idem C3 | `/fr/settings/smtp` | Retour au tableau de bord |
| C5 | `alpha-analyst@seed.test` | Idem C3 | `/fr/admin/organizations` | Retour au tableau de bord, aucune donnée d'administration |
| C6 | `beta-owner@seed.test` | Membres, Paramétrage ; **pas d'Administration** | `/fr/admin/organizations` | Retour au tableau de bord |

## D. Membres et invitations (J11)

Se connecter avec `alpha-admin@seed.test` (ou `shared@seed.test` dans Alpha), page **Membres**.

| ID | Étapes | Résultat attendu |
|---|---|---|
| D1 | Vérifier **Membres de l'équipe** : lignes « Membre 000001 (vous) » etc., rôle et statut Actif. | La liste d'Alpha uniquement (jamais de membre de Beta). Les membres sont identifiés par un identifiant court (pas d'e-mail, limite connue). |
| D2 | **Inviter un membre** : e-mail `testeur2@seed.test`, rôle **Analyste** → **Créer le lien d'invitation**. | Notification verte « Le lien d'invitation a été créé. » Une fenêtre affiche le lien **une seule fois** : le copier (**Copier le lien**). L'invitation apparaît dans **Invitations en attente**. |
| D3 | Créer le compte `testeur2@seed.test` (A5, confirmer l'e-mail), se connecter, ouvrir le lien copié, cliquer **Accepter l'invitation**. | Accès à Alpha avec le rôle Analyste. Côté Alpha, le membre est **Actif** et l'invitation a disparu de la liste. |
| D4 | Avec un **autre** compte (ex. `alpha-sales@seed.test`) ouvrir un lien d'invitation destiné à une autre adresse. | Message d'erreur générique « invalide, expirée ou associée à un autre compte ». Aucun accès accordé. |
| D5 | Créer une invitation puis **Révoquer**. Essayer d'ouvrir son lien. | Notification « L'invitation a été révoquée. » Le lien ne fonctionne plus (même message générique). |
| D6 | Ouvrir le menu d'un membre → **Modifier le rôle** → choisir un autre rôle → **Enregistrer le rôle**. | Notification verte « Le rôle a été mis à jour ». |
| D7 | Avec **l'administrateur** : essayer d'attribuer le rôle **Propriétaire** ou de modifier la ligne du propriétaire. | Impossible (option absente ou refus). |
| D8 | Avec le **propriétaire** : tenter de retirer ou de rétrograder le **dernier** propriétaire. | Refus avec le message « Le dernier propriétaire ne peut être ni retiré ni rétrogradé. Transférez d'abord la propriété. » |
| D9 | **Retirer** un membre (confirmer). Se connecter avec ce compte. | Le membre disparaît de la liste ; le compte retiré n'a plus accès à Alpha. |
| D10 | **Transférer la propriété** à un autre membre (confirmer). | Notification « La propriété a été transférée. » Les rôles sont échangés. (À défaire avec `pnpm db:reset`.) |

## E. Plans et quotas (J14)

| ID | Étapes | Résultat attendu |
|---|---|---|
| E1 | Tableau de bord d'Alpha (propriétaire ou administrateur) : carte **Utilisation du plan**. | Compteurs par métrique (Utilisateurs, Projets, Fiches de contact, Messages, Exécutions IA, Intégrations) avec la limite du plan. Alpha est au plan **Croissance** (15 utilisateurs). |
| E2 | `shared@seed.test` → **Administration** (liste des organisations ; seul ce compte y a accès). | Alpha et Beta, plan, statut, nombre de membres actifs. |
| E3 | Ouvrir Alpha, choisir la formule **Essai** (3 utilisateurs), saisir un **Motif de la décision** (≤ 200 caractères), **Enregistrer l'abonnement**. | Notification verte « Abonnement enregistré. » |
| E4 | Revenir dans Alpha (propriétaire) et tenter d'inviter une personne. | Refus : « La limite d'utilisateurs de votre plan est atteinte. Contactez l'administrateur de la plateforme. » (Alpha a déjà 5 membres actifs pour une limite de 3.) |
| E5 | Rétablir la formule **Croissance** dans Administration. Réessayer d'inviter. | L'invitation est de nouveau possible. |
| E6 | Administration : saisir un **Motif** de plus de 200 caractères. | Le formulaire refuse (limite affichée). |
| E7 | Comparer les compteurs de Alpha et de Beta. | Chaque entreprise a ses propres compteurs (jamais mélangés). |

## F. Paramétrage — Thème (palette de couleurs)

Menu **Paramétrage → Thème** (propriétaire ou administrateur).

| ID | Étapes | Résultat attendu |
|---|---|---|
| F1 | Cliquer **Orangé** (palette prête à l'emploi) puis **Enregistrer la palette**. | Notification verte « Palette enregistrée. » Les couleurs de l'application changent. |
| F2 | Se déconnecter. | La page de connexion a aussi les nouvelles couleurs (palette globale). |
| F3 | Modifier une couleur à la main de façon à rendre un texte illisible (ex. fond clair avec texte clair). | Message « Contraste insuffisant » et **enregistrement bloqué**. |
| F4 | **Rétablir les couleurs par défaut**. | Notification « Couleurs par défaut rétablies. » Retour au vert. |
| F5 | Basculer en **mode sombre** (icône du thème, en haut). | Toute l'interface reste lisible. |

## G. Paramétrage — Profil (logo)

Menu **Paramétrage → Profil**.

| ID | Étapes | Résultat attendu |
|---|---|---|
| G1 | **Choisir une image** : un PNG de moins de 128 Ko → **Enregistrer le logo**. | Notification verte « Logo enregistré. » Le logo apparaît dans le menu latéral. |
| G2 | Essayer un fichier **SVG**, puis un fichier de plus de 128 Ko, puis un fichier texte renommé en `.png`. | Refus à chaque fois avec une notification **rouge**. |
| G3 | Se déconnecter. | La page de connexion garde le **logo officiel FUSION LEAP** (il ne change pas avec le logo personnalisé). |
| G4 | **Rétablir le logo par défaut**. | Notification « Logo par défaut rétabli. » |

## H. Paramétrage — Serveur SMTP (administrateurs de la plateforme)

Avec `shared@seed.test` (seul administrateur de la plateforme du jeu de test), menu **Paramétrage → Serveur SMTP**.

| ID | Étapes | Résultat attendu |
|---|---|---|
| H1 | Avec `alpha-sales@seed.test` : ouvrir `/fr/settings/smtp`. | Retour au tableau de bord (page réservée aux administrateurs de la plateforme). |
| H2 | **Utiliser Mailtrap** : serveur, port, sécurité et expéditeur se remplissent. Saisir **Utilisateur** et **Mot de passe** de la boîte Mailtrap (fournis par la responsable technique). **Enregistrer**. | Notification verte « Paramètres SMTP enregistrés ». Le champ mot de passe affiche « un mot de passe est enregistré » (il n'est **jamais** réaffiché). |
| H3 | **Envoyer un e-mail de test**. | Notification verte « E-mail de test envoyé à votre adresse. » Dans Mailtrap : e-mail avec **logo FUSION LEAP**, **une seule langue** (celle de l'interface), signature, date et barre rouge « Tous droits réservés ». |
| H4 | Changer le **Serveur SMTP** sans ressaisir le mot de passe, puis enregistrer. | Refus : un nouveau mot de passe est obligatoire. |
| H5 | Saisir des identifiants faux, enregistrer, **Envoyer un e-mail de test**. | Notification **rouge** « Identifiants refusés » (jamais le message technique du serveur). |
| H6 | **Supprimer la configuration**. | Notification « Configuration SMTP supprimée. » Le bouton de test est désactivé. |

## I. Interface générale

| ID | Étapes | Résultat attendu |
|---|---|---|
| I1 | Parcourir : accueil, connexion, inscription, tableau de bord, membres, paramétrage, administration. | **Pied de page** présent partout. |
| I2 | Provoquer un succès (ex. enregistrer la palette) puis une erreur (ex. mauvais mot de passe). | Notifications **en haut au centre** : **verte** pour le succès, **rouge** pour l'erreur, bouton de fermeture, disparition automatique. |
| I3 | Changer de langue (sélecteur en haut) : **Arabe**. | Texte de droite à gauche, menu latéral et tableaux inversés, aucune zone coupée. |
| I4 | Réduire la fenêtre à la largeur d'un téléphone (≈ 390 px). | Pas de défilement horizontal ; menu latéral repliable ; formulaires utilisables. |
| I5 | Naviguer au clavier (Tab) sur la page de connexion. | Focus visible sur chaque champ et bouton ; Entrée valide le formulaire. |

## J. Isolation entre entreprises (critère §13-1 — le plus important)

Utiliser deux fenêtres : une normale, une privée.

| ID | Étapes | Résultat attendu |
|---|---|---|
| J1 | Fenêtre 1 : `alpha-admin@seed.test`. Fenêtre 2 : `beta-owner@seed.test`. Comparer **Membres**. | Chacun ne voit que **sa** liste. Aucun nom, rôle ou invitation de l'autre entreprise. |
| J2 | Fenêtre 1 : créer une invitation dans Alpha. Fenêtre 2 : recharger **Membres**. | L'invitation n'apparaît **pas** chez Beta. |
| J3 | `shared@seed.test` : passer d'Alpha à Beta, puis ouvrir `/fr/members` (lien d'Alpha). | Dans Beta (rôle Commercial) : retour au tableau de bord ; aucune donnée d'Alpha. |
| J4 | Se connecter avec `beta-analyst@seed.test` (Analyste de Beta). | Ni **Membres** ni **Paramétrage** dans le menu ; rien d'Alpha n'est visible. |
| J5 | `alpha-admin@seed.test` : essayer d'ouvrir une page d'une autre entreprise par l'adresse (aucun identifiant d'entreprise n'est dans les adresses). | Aucune page d'une autre entreprise n'est accessible. |

## K. E-mails d'authentification

| ID | Étapes | Résultat attendu |
|---|---|---|
| K1 | Inscription (A5) en **français**. Ouvrir l'e-mail dans Mailtrap. | **Une seule langue** (français), logo FUSION LEAP en tête, bouton **Confirmer mon e-mail**, barre rouge « Tous droits réservés ». Le lien fonctionne. En local, le logo peut ne pas s'afficher dans Mailtrap (limite connue : il s'affiche en production). |
| K2 | Même chose en **anglais**, puis en **arabe** (changer la langue avant l'inscription). | E-mail dans la langue de l'inscription (anglais ; arabe de droite à gauche). |
| K3 | « Mot de passe oublié » (A7). | E-mail de réinitialisation, une seule langue, bouton **Choisir un nouveau mot de passe**. |

---

## L. Tests techniques (base de données) — optionnel, pour un profil technique

Ouvrir Supabase Studio : `http://127.0.0.1:54323` → **SQL Editor**.

| ID | Requête | Résultat attendu |
|---|---|---|
| L1 | `select action, entity_type, created_at from public.audit_logs order by created_at desc limit 10;` après avoir fait D2, D6, D9. | Lignes `invitation.created`, `member.role_changed`, `member.removed`… **sans** mot de passe, jeton ni contenu de message. |
| L2 | `update public.audit_logs set action = 'x';` | **Erreur** : le journal d'audit est en ajout seul. |
| L3 | `delete from public.audit_logs;` | **Erreur** (même raison). |

## M. Jobs et worker — optionnel

1. Dans un terminal : `pnpm worker:dev` (laisser tourner).
2. Dans le SQL Editor, créer un job de démonstration (remplacer l'identifiant d'une entreprise : `select id, name from public.organizations;`) :
   ```sql
   select private.enqueue_job('<id>', 'noop', '{}'::jsonb, 'demo-' || gen_random_uuid());
   ```
3. Résultat attendu : le terminal du worker affiche une ligne de journal (job réclamé puis terminé), et :
   ```sql
   select kind, status, attempts from public.jobs order by created_at desc limit 5;
   ```
   montre le job en `succeeded`. Aucune charge utile n'est écrite dans le journal du worker.
4. Arrêter le worker avec `Ctrl+C` : arrêt propre (message de fin).

## N. Suite automatique (développeurs)

À lancer avant de rendre le rapport ; tout doit être vert. Prérequis : pile locale et application démarrées (`pnpm db:start`, `pnpm dev`).

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:rls
pnpm test:db
pnpm test:e2e
```

`pnpm test:e2e` exécute les scénarios d'isolation (T1) et de changement d'entreprise (T5). Si `pnpm test:db` échoue sur `050_service_layer`, faire `pnpm db:reset` puis relancer.

---

## Fiche de résultats

Copier ce tableau dans un tableur. **OK / KO / N/A**, date, nom du testeur.

| Partie | Cas | Résultat | Commentaire / n° d'anomalie |
|---|---|---|---|
| A. Accès | A1 … A8 | | |
| B. Organisations | B1 … B5 | | |
| C. Rôles | C1 … C6 | | |
| D. Membres | D1 … D10 | | |
| E. Plans et quotas | E1 … E7 | | |
| F. Thème | F1 … F5 | | |
| G. Profil (logo) | G1 … G4 | | |
| H. SMTP | H1 … H6 | | |
| I. Interface | I1 … I5 | | |
| J. Isolation | J1 … J5 | | |
| K. E-mails | K1 … K3 | | |
| L. Base de données | L1 … L3 | | |
| M. Worker | M | | |
| N. Suite automatique | 6 commandes | | |

## Signaler une anomalie

Une fiche par problème :

- **ID du cas** (ex. D4) et **titre** court.
- **Compte utilisé** (adresse de test) et **langue** de l'interface.
- **Étapes** pour reproduire (numérotées).
- **Résultat obtenu** et **résultat attendu**.
- **Capture d'écran** (ou enregistrement) ; adresse de la page ; navigateur.
- **Gravité** : bloquante (accès à des données d'une autre entreprise, perte de données, impossibilité de se connecter), majeure (fonction inutilisable), mineure (affichage, texte).
- Ne **jamais** coller de mot de passe, de jeton ni de lien d'invitation dans la fiche.

> Toute fuite de données d'une entreprise vers une autre (partie J) est **bloquante** : prévenir immédiatement la responsable technique.

## Limites connues (à ne pas signaler comme anomalies)

- Les membres sont listés par identifiant court (« Membre 000002 »), sans e-mail.
- En local, le logo des e-mails d'authentification ne s'affiche pas dans Mailtrap.
- « Mot de passe oublié » suit la langue de la dernière inscription ou connexion du compte.
- Les valeurs des plans (Essai, Démarrage, Croissance) sont provisoires.
- Un abonnement en retard de paiement ou expiré reste utilisable (pas d'expiration automatique).
- Le Paramétrage (Thème, Profil) est modifiable par tout propriétaire ou administrateur d'organisation (décision en attente).
