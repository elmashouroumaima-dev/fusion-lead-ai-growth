# WhatsApp avec Kapso, pas à pas (essai réel en local)

Procédure suivie le 24 novembre 2026 pour faire fonctionner WhatsApp (sandbox Kapso) sur un poste local : réception d'un message, réponse depuis l'Inbox, statuts. Elle complète `docs/runbooks/whatsapp-setup.md` (référence) par l'ordre exact des gestes et par les pannes rencontrées.

**Principe** : Kapso envoie ses événements (message reçu, envoyé, lu…) par Internet à l'application ; l'application les accepte seulement s'ils sont **signés avec le secret de webhook** qu'elle connaît. Il faut donc trois choses d'accord : une **adresse publique** (tunnel), une **clé d'API** valide, et le **même secret** des deux côtés.

## 0. Ce qu'il faut avoir
- Un compte Kapso, le **sandbox WhatsApp** (numéro de test partagé) et votre téléphone de test.
- L'application et le worker lancés en local ; la base locale démarrée.
- Aucune donnée de client réel : uniquement votre téléphone.

## 1. Lancer l'application, le worker et le tunnel (trois terminaux)
1. `pnpm dev`
2. `pnpm worker:dev`
3. `cloudflared tunnel --url http://localhost:3000` : relever l'adresse `https://xxxx.trycloudflare.com` affichée.

> **Cette adresse change à chaque lancement de `cloudflared`.** À chaque fois : refaire les étapes 2 et 5.

## 2. Mettre l'adresse du tunnel dans l'application
1. Dans `.env.local` (racine, non versionné) : `SITE_URL=https://xxxx.trycloudflare.com`.
2. Arrêter puis relancer `pnpm dev` et `pnpm worker:dev` (`SITE_URL` n'est lu qu'au démarrage).
3. Vérifier : `curl -i -X POST https://xxxx.trycloudflare.com/api/webhooks/kapso -H "content-type: application/json" -d "{}"` répond **400** (corps vide : normal). Une erreur de connexion, 530 ou 1033 = tunnel ou application arrêtés.

## 3. Côté Kapso : la session et la clé d'API
1. **Sandbox WhatsApp → Sessions** : la session de votre téléphone doit être **active**. Sinon : *Add session*, saisir votre numéro (`+212…`), puis envoyer le code d'activation au numéro du sandbox depuis votre téléphone (valable 15 minutes).
2. **Phone number ID** : le relever dans la liste des numéros (ici `597907523413541`). S'il change (nouvelle session), il faut une nouvelle intégration.
3. **Integrate → API keys → Create API key** : copier la clé tout de suite (elle ne s'affiche qu'une fois). **Ne jamais la coller dans une conversation ni dans un fichier.** Supprimer les anciennes clés.

## 4. Côté application : l'intégration et le canal
1. **Intégrations → onglet WhatsApp → Connecter un numéro WhatsApp (Kapso)** : Phone number ID, clé d'API, secret de webhook (bouton *Générer*), *Connecter et vérifier*. Si l'intégration existe déjà (« Ce numéro est déjà connecté »), ne pas la recréer : utiliser sa carte.
2. Carte de l'intégration, **Nouveau jeton → Remplacer** : coller la nouvelle clé d'API (si l'état est *Error* avec le code `provider_auth`, c'est la clé qui est refusée).
3. **Vérifier la connexion** : l'état doit devenir **Active**. Si « Kapso is unavailable » : réessayer deux ou trois fois (délai ou panne passagère ; l'intégration n'est jamais dégradée pour cela).
4. **Ajouter un numéro** (canal) : saisir le numéro (format `+212…`). Il doit être **Active**.

## 5. Le secret de webhook : le même des deux côtés
C'est l'étape qui bloque le plus souvent (événements refusés `signature_invalid`).
1. Carte de l'intégration, **Secret de webhook → Générer** : un secret de 64 caractères apparaît dans le champ.
2. **Le copier tout de suite** (Ctrl+A, Ctrl+C dans le champ) ; ne pas recliquer *Générer* ensuite.
3. Cliquer **Remplacer le secret** (le champ se vide : le secret n'est plus jamais affiché).
4. **Kapso → Sandbox WhatsApp → Webhooks** → le webhook → **Edit** → **Advanced → Signing secret** : **coller** le secret (sans espace) → **Save webhook**. Laisser ce champ vide conserve l'ancien secret, qui ne correspond plus.
5. Dans le même formulaire, vérifier l'**adresse** : exactement
   `https://xxxx.trycloudflare.com/api/webhooks/kapso`, **sans « / » à la fin** (avec, le serveur répond 308 et Kapso compte l'envoi comme échoué). Événements utiles : message reçu, envoyé, lu, remis, conversation, préférence marketing. Ne pas toucher « Payload version » ni « Custom headers ».
6. Ne **pas** utiliser *Déconnecter* pour « réparer » : la déconnexion supprime la clé et les secrets.

## 6. Créer le contact et la conversation de test
Avec le canal actif, créer le contact de test (votre téléphone) et sa conversation :
```powershell
docker exec -i supabase_db_fusion-leap psql -U postgres -v ON_ERROR_STOP=1 -v mail_sender='' -v wa_sender='+NUMERO_DU_CANAL' -v tester_name='Testeur WhatsApp' -v tester_email='' -v tester_phone='+VOTRE_TELEPHONE' < docs/testing/fixtures/c3-contact.sql
```
Remplacer `+NUMERO_DU_CANAL` par le numéro saisi à l'étape 4.4 et `+VOTRE_TELEPHONE` par votre téléphone (`+212…`), **sans les chevrons** d'un exemple. Message « canal introuvable ou pas actif » : le canal n'existe pas encore ou la valeur est fausse.

## 7. Le test
1. Depuis votre téléphone, écrire « salam » au **numéro du sandbox Kapso**.
2. **Inbox** : la conversation « Testeur WhatsApp » apparaît avec le message.
3. **Répondre depuis l'Inbox** (dans les 24 heures qui suivent votre message) : la réponse arrive sur le téléphone ; son statut passe à envoyé, remis puis lu.
4. Chez Kapso, *Last delivery* du webhook passe à « delivered, just now ».
5. Facultatif : écrire STOP depuis le téléphone : le consentement est retiré et les envois suivants sont refusés.

## 8. Vérifier dans la base si ça ne marche pas
```powershell
docker exec supabase_db_fusion-leap psql -U postgres -d postgres -c "select status, signature_valid, failure_code, to_char(received_at,'HH24:MI:SS') from public.webhook_events where provider='whatsapp' order by received_at desc limit 8"
docker exec supabase_db_fusion-leap psql -U postgres -d postgres -c "select external_account_id, status, last_error from public.integrations where provider='whatsapp'"
```

| Constat | Cause | Remède |
|---|---|---|
| Aucune ligne dans `webhook_events` | Kapso n'envoie rien à cette adresse : session inactive, mauvais numéro, tunnel relancé (adresse changée), webhook désactivé | Étapes 1, 3 et 5.4 ; chez Kapso, *Last delivery* |
| `rejected` / `signature_invalid` | Secret de webhook différent des deux côtés (secret régénéré après la copie, espace en trop, champ Kapso laissé vide) | Étape 5 en entier, un seul secret |
| Le tunnel répond 308 ou 404 | Adresse mal saisie chez Kapso (slash final, chemin coupé) | Étape 5.5 |
| `last_error` = `provider_auth` | Clé d'API refusée | Étapes 3.3 et 4.2 |
| `last_error` = `provider_account` | Phone number ID inexact ou numéro d'une autre session | Étape 3.2 |
| `last_error` = `provider_unavailable` | Kapso ou réseau lent, 429, 5xx | Réessayer |
| `processed` mais pas de message dans l'Inbox | Aucun contact avec ce numéro (l'expéditeur inconnu va dans la file des cas ambigus), ou plusieurs canaux sur l'intégration | Étape 6 |

## 9. Ce qui a été constaté le 24 novembre 2026
Après correction du secret (étape 5) : message entrant reçu (« Salam »), réponse depuis l'Inbox envoyée puis **lue** (statuts reçus par webhook signé), événements `processed` avec signature valide. Rien de réel n'a été envoyé à un client.
