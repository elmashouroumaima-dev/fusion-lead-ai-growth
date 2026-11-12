# E-mails de développement (Mailtrap)

Les e-mails d'authentification (confirmation d'inscription, réinitialisation du mot de passe) sont envoyés par Supabase Auth local vers une **boîte de test Mailtrap** : tous les messages y sont capturés, quel que soit le destinataire, et rien n'est livré à de vraies boîtes.

## Mise en place (une fois)
1. Créer un compte Mailtrap, puis *Email Testing > Inboxes* : ouvrir (ou créer) une boîte.
2. Onglet *SMTP Settings* : copier **Username** et **Password**.
3. Copier `supabase/.env.local.example` vers `supabase/.env` (ce fichier est ignoré par git) et renseigner `MAILTRAP_SMTP_USER` et `MAILTRAP_SMTP_PASS`. Ne jamais coller ces valeurs dans le code, dans `config.toml` ni dans une conversation.
4. Redémarrer la pile locale : `pnpm db:stop` puis `pnpm db:start`.

## Utilisation
- S'inscrire sur `http://127.0.0.1:3000/fr/signup` : l'e-mail de confirmation apparaît dans la boîte Mailtrap (sujet en français, arabe et anglais). Ouvrir le lien pour confirmer le compte.
- Limite locale : `[auth.rate_limit] email_sent = 10` par heure (`supabase/config.toml`).
- Tant que les identifiants sont absents, l'inscription échoue côté e-mail (erreur 500 de Supabase Auth). Pour un parcours sans e-mail, créer le compte par l'API d'administration avec `email_confirm: true`.

## Gabarits des e-mails (logo, trois langues, « Tous droits réservés »)
- Source unique : `packages/adapters/src/email` (gabarit HTML en tableaux avec styles en ligne, 600 px, logo en tête, signature en gras, barre de pied « © Fusion Leap AI Growth. Tous droits réservés. »). **Une seule langue par message** (fr, ar en RTL ou en).
- Les fichiers `supabase/templates/confirmation.html` et `recovery.html` et les objets de `supabase/config.toml` sont **générés** : modifier la source puis lancer `pnpm email:templates` (un test échoue si un fichier diffère). Redémarrer la pile (`pnpm db:stop`, `pnpm db:start`) pour que Supabase Auth les relise.
- **Langue des e-mails d'authentification** : Supabase Auth choisit la variante selon `user_metadata.locale`, enregistrée à l'inscription (langue de la page) et mise à jour à la connexion si elle change ; sans valeur (comptes du seed), français. Ce champ ne sert qu'à choisir le texte : jamais une décision d'autorisation. Une demande « mot de passe oublié » suit donc la langue de la dernière inscription ou connexion du compte, pas celle de la page où elle est faite (Supabase ne permet pas de la transmettre).
- **Message de test SMTP** : langue de l'interface de l'administrateur qui le déclenche.
- Logo : logo officiel « FUSION LEAP — Intelligent systems. Limitless impact. » en blanc sur fond transparent (`apps/web/public/brand/email-logo.png`, 480×97 px affiché à 260×53 px, extrait du fichier fourni par la direction), servi par le site (`{{ .SiteURL }}/brand/email-logo.png`). **En local**, la boîte Mailtrap (dans le cloud) ne peut pas atteindre `127.0.0.1` : le logo des e-mails d'authentification n'apparaît qu'avec un domaine public (staging, production) ; le texte alternatif s'affiche à la place.
- Le message de test SMTP du Paramétrage (`lib/smtp/send-test.ts`) joint le logo (`cid:`), donc il s'affiche partout, même en local ; son pied de page porte l'année.
- Les gabarits d'authentification n'ont ni année ni date (Supabase Auth ne fournit pas la date courante).

## CI
La CI n'utilise pas ces identifiants : la pile CI exclut l'e-mail (pas de test de bout en bout des e-mails avant J57/J60).

## Production
Fournisseur d'e-mail de production : candidat Resend (ADR 008, à valider) ; domaine d'envoi (SPF/DKIM) à décider (question Q2).

## Paramètres SMTP de l'application
Le Paramétrage de l'application (carte « Paramètres SMTP », administrateurs de la plateforme) enregistre un SMTP **de l'application** (test d'envoi, futur adaptateur e-mail) ; il est distinct du SMTP de Supabase Auth décrit ci-dessus. Voir `docs/runbooks/smtp-settings.md`.

