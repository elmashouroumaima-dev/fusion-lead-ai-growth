# Désabonnement (J33)

Migration `20261203100000_unsubscribe.sql` (retour arrière : `supabase/rollbacks/20261203100000_unsubscribe.sql`). Spec §9.2, plan J33, ADR 008. Routes **publiques** (sans session).

## Flux
Chaque e-mail envoyé par le worker porte un **lien de désabonnement signé** : en-têtes `List-Unsubscribe: <lien>` et `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058, RFC 2369) et un pied de page « Se désabonner : <lien> ». Sans clé de signature (clé maître absente), le worker **n'envoie rien** : la tentative est libérée et le job échoue pour être rejoué.

| Étape | Qui | Ce qui se passe |
|---|---|---|
| 1 | worker | `appendUnsubscribeFooter` + `listUnsubscribeHeaders` à partir d'un jeton signé (entreprise + message) |
| 2 | destinataire | ouvre le lien : `GET /api/unsubscribe/<jeton>` renvoie **302** vers `/<langue>/unsubscribe/<jeton>` (le site configuré, jamais l'hôte de la requête). **Ouvrir le lien ne désabonne pas** (les analyseurs de liens des messageries le font) |
| 3 | destinataire | confirme sur la page (action serveur) **ou** sa messagerie envoie `POST /api/unsubscribe/<jeton>` avec le corps `List-Unsubscribe=One-Click` |
| 4 | base | `unsubscribe_apply(p_org, p_message)` (service_role seulement, une transaction, idempotente) |

## Jeton (`packages/adapters/src/email/unsubscribe.ts`)
`v1.<version de clé>.<entreprise>.<message>.<HMAC-SHA256 base64url>` : **aucune donnée personnelle** (deux UUID et une signature). La clé est **dérivée** (HKDF-SHA256, étiquette `fusion-leap/unsubscribe/v1`) de la clé maître du trousseau (ADR 004) : distincte de la clé de chiffrement des secrets, sans nouvelle variable d'environnement. La version de clé est dans le jeton et le vérificateur sait valider plusieurs versions (testé avec un trousseau à deux clés). **Limite actuelle** : en production, l'application et le worker ne chargent qu'UNE clé (`SECRETS_MASTER_KEY`, `SECRETS_KEY_VERSION`) ; une rotation casserait donc aussi les anciens liens (et le déchiffrement des anciens secrets : même limite pour tout le trousseau, ADR 004). Une variable des clés précédentes est à décider avant la première rotation (point ouvert). **Pas d'expiration** : un lien de désabonnement doit rester utilisable ; son seul effet est de retirer un consentement. Vérification à temps constant. L'entreprise et le contact viennent TOUJOURS de la ligne du message en base, jamais d'un champ du client.

## Routes
- `GET /api/unsubscribe/[token]` : 302 vers la page (404 si le jeton n'a pas la forme attendue). N'écrit rien.
- `POST /api/unsubscribe/[token]` : un clic. Corps `List-Unsubscribe=One-Click` (512 octets au plus). `200 {ok:true}` (idempotent), `400 invalid_request | invalid_link` (corps différent, jeton falsifié, message inconnu ; forme et signature sont vérifiées AVANT la limite et la base), `429` (limite par adresse : 120 en rafale puis 2 par seconde, seau `unsubscribe_ip` ; sans adresse reconnue, un seau commun), `503` (base indisponible : la messagerie peut réessayer ; sans clé de signature configurée aucun lien n'a pu être émis, la réponse est 400). Format d'erreur `{ code, request_id }`.
- Page `/{fr,ar,en}/unsubscribe/[token]` : publique **parce que son adresse contient des points** (le matcher du proxy exclut ces chemins, comme `/api` : pas de session ni de redirection vers la connexion ; la langue vient du chemin), `noindex`, `Referrer-Policy: no-referrer`. États : confirmation, désabonné, lien invalide, erreur (réessayer). Textes génériques : rien ne révèle l'adresse, l'entreprise ni l'existence d'un compte.

## Effet en base (`unsubscribe_apply`)
1. révoque **tous** les consentements `email` actifs du contact (autres canaux intacts ; historique append-only : seule la date de révocation s'ajoute) ;
2. inscrit l'adresse dans `suppressions` (raison `unsubscribe`, message source tracé) : un nouveau consentement saisi ensuite ne rétablit pas l'envoi (le contrôle final refuse l'adresse supprimée) ;
3. annule les messages sortants **en file et non réclamés** du contact (`cancelled`) et leurs jobs `send_message` ; un envoi déjà réclamé par le worker n'est pas touché ici : le contrôle final le refuse si le désabonnement a eu lieu avant la réclamation, sinon l'appel au fournisseur peut partir (fenêtre de quelques secondes) ;
4. audit : `unsubscribe.applied`, `suppression.added`, `message.cancelled` (écrits par la fonction) et `consent.revoked` (écrit par le déclencheur de `consent_events`) : identifiants et nombres seulement, jamais l'adresse ni le corps. L'adresse supprimée est celle où le message est parti (`approved_recipient`) : si l'e-mail du contact a changé depuis, la nouvelle adresse n'est pas supprimée (changer d'e-mail révoque déjà les consentements).
Résultats : `applied` ou `already` ; `not_found` (PT404) si le message n'existe pas dans l'entreprise du jeton, `validation_failed` (22023) pour une entrée nulle.

## Réabonnement
Il n'existe **pas encore** de fonction pour lever une désinscription : une personne habilitée devra le faire par une action auditée (écran contacts, J30b). Tant que ce n'est pas fait, l'adresse reste supprimée.

## Tests
pgTAP `260_unsubscribe` (42), adaptateurs (`unsubscribe` : jeton, rotation, falsification ; Postmark : en-têtes), worker (3 : lien signé, absence de clé, adresse supprimée), web (service, route, chemins publics), acceptation HTTP `unsubscribe-flow`.
