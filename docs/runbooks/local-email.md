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

## CI
La CI n'utilise pas ces identifiants : la pile CI exclut l'e-mail (pas de test de bout en bout des e-mails avant J57/J60).

## Production
Fournisseur d'e-mail de production : candidat Resend (ADR 008, à valider) ; domaine d'envoi (SPF/DKIM) à décider (question Q2).
