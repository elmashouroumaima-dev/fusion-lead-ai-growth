# Paramètres SMTP de la plateforme (Paramétrage)

## Principe
La page **Paramétrage > Serveur SMTP** (`/{locale}/settings/smtp`, menu latéral déroulant « Paramétrage ») enregistre le serveur d'envoi d'e-mails de la plateforme : serveur, port, sécurité (TLS direct, STARTTLS ou aucune), utilisateur, **mot de passe**, adresse et nom de l'expéditeur. Un bouton **Utiliser Mailtrap** préremplit la boîte de test (`sandbox.smtp.mailtrap.io`, port 2525, STARTTLS) ; il reste à saisir l'utilisateur et le mot de passe de votre boîte.

- **Qui** : les administrateurs de la plateforme seulement (`private.platform_admins`). Un owner/admin d'organisation ne voit pas la carte et la base refuse ses appels : une configuration SMTP globale modifiable par un client permettrait de capter les liens de réinitialisation de mot de passe.
- **Mot de passe** : chiffré par l'application avec **AES-256-GCM** (nonce unique, AAD = `platform:smtp:<id du secret>`) AVANT d'atteindre la base ; seul le chiffré est stocké (`private.secrets`, aucun droit d'API). Aucune réponse ne le renvoie : l'interface affiche seulement « un mot de passe est enregistré ». Laisser le champ vide conserve l'ancien ; en saisir un remplace (l'ancien est supprimé).
- **Clé maître** : variable d'environnement **serveur** `SECRETS_MASTER_KEY` (base64 de 32 octets) et `SECRETS_KEY_VERSION` (défaut 1). Jamais dans la base ni dans le dépôt, jamais `NEXT_PUBLIC_*`. Sans elle, les paramètres s'enregistrent mais pas le mot de passe (message explicite, aucun repli en clair).
- **Mot de passe non transférable** : si l'hôte, le port ou l'utilisateur changent, un **nouveau mot de passe est obligatoire** (`password_required`). Sans cette règle, un administrateur pourrait faire envoyer l'ancien mot de passe, déchiffré par le test d'envoi, vers un serveur de son choix.
- **Validation** : adresse d'expéditeur simple (sans virgule, chevrons ni guillemets) ; nom d'expéditeur et utilisateur sans caractère de contrôle, bidi, séparateur de ligne, BOM ni caractère de balise ; deux enregistrements simultanés sont sérialisés (verrou consultatif), donc aucun secret orphelin.
- **Test d'envoi** : envoie un message à **l'adresse de l'administrateur connecté** (jamais une saisie libre : pas de relais de courrier). L'hôte interne (localhost, IP privées, `169.254.x.x`, noms `.local` / `.internal`) est refusé hors développement, avant ET après la résolution DNS ; on se connecte à l'adresse résolue et contrôlée (pas de rebinding DNS). Délais de 10 s. Les formes numériques ambiguës (`2130706433`, `0x7f.1`, `017700000001`, `127.1`) sont refusées comme noms d'hôte ; pour l'IPv6, seule l'unicast globale (`2000::/3`, hors 6to4, Teredo et documentation) est acceptée, une adresse IPv4-mappée est jugée d'après son IPv4, toute forme invalide est refusée. Les erreurs sont réduites à un code (`auth_failed`, `connection_failed`, `timeout`, `blocked_host`, `rejected`, `failed`), jamais le message du serveur.

La clé maître est refusée si elle est triviale (moins de 16 valeurs d'octet distinctes). `pnpm check:leaks` compare le bundle navigateur aux valeurs des variables du shell **et** de `.env` / `.env.local`.

## Générer la clé maître (local)
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
Coller le résultat dans `.env.local` (`SECRETS_MASTER_KEY=…`, jamais commité) puis redémarrer `pnpm dev`. En staging et production, la clé est fournie par le gestionnaire de secrets de l'hébergeur (à décider, ADR 010) ; **la perdre rend les mots de passe illisibles** (il faudra les ressaisir).

## Rotation de la clé maître
Le trousseau (`createKeyRing`) sait déchiffrer toute version connue et chiffre avec la courante. Procédure prévue (non automatisée à ce jour) : ajouter la nouvelle clé sous une nouvelle version, ressaisir le mot de passe SMTP (nouveau chiffré en version courante), retirer l'ancienne version.

## Ce que fait (et ne fait pas) cette configuration
- Elle est **stockée** et **testée** ; l'adaptateur e-mail (J31) la lira (`get_smtp_delivery`, service_role, puis déchiffrement côté serveur).
- Elle **ne remplace pas** le SMTP de Supabase Auth (e-mails de confirmation et de réinitialisation) : en local il se règle dans `supabase/config.toml` / `supabase/.env` (voir `local-email.md`), en hébergé dans le tableau de bord Supabase.

## Traçabilité et limites
- Pas de ligne dans `audit_logs` (table par organisation, `organization_id` obligatoire) : les enregistrements, suppressions et tests sont journalisés côté serveur (`smtp_settings_saved`, `smtp_settings_reset`, `smtp_test`, sans hôte, utilisateur ni mot de passe).
- Une seule configuration globale ; SMTP par organisation (envoi au nom d'une entreprise) = module Intégrations (J28 à J30).
- Le DNS rebinding est neutralisé pour le test (connexion à l'IP contrôlée) ; un hôte qui résout vers plusieurs adresses utilise la première.
