# Contacts et consentement (J18)

Migration `20261120100000_contacts_consent.sql` (retour arrière : `supabase/rollbacks/20261120100000_contacts_consent.sql`). Spec §7 et §9, ADR 007 (G-D3, G-D4), ADR 014. Pas d'écran au J18 : la couche base, le domaine et le service sont livrés ; l'interface CRM vient avec J24.

## Modèle
- **`contacts`** : `name`, `email_raw` (saisie), `email_normalized` (minuscules), `phone_e164`, `language` (2 lettres), `country` (ISO alpha-2), `consent_status` (dérivé), `do_not_contact`, `external_source` / `external_id`, `attributes` (objet plat, 8 Ko au plus). Au moins un identifiant (e-mail ou téléphone).
- **`consent_events`** (source de vérité) : `contact_id`, `channel` (`email`, `whatsapp`), `purpose` et `source` (codes courts en minuscules), `proof` (texte, version, IP, URL https — rien d'autre), `captured_at`, `revoked_at`. **Append-only** : seule la date de révocation peut s'ajouter ; aucune suppression.
- **Unicité en base** (index uniques partiels) : `(organization_id, email_normalized)`, `(organization_id, phone_e164)`, `(organization_id, external_source, external_id)`. Le même e-mail dans deux entreprises donne deux contacts.
- **Statut dérivé** : `granted` (au moins un consentement non révoqué), `revoked` (des consentements, tous révoqués), `unknown` (aucun).

## Droits
| Rôle | Lire | Créer / modifier | Consentement (enregistrer, révoquer, poser « ne plus contacter ») | Retirer « ne plus contacter » |
|---|---|---|---|---|
| owner, admin | oui | oui | oui | oui |
| marketing | oui | oui | oui | non |
| commercial | non (au J19 : ses leads) | non | non | non |
| analyste | non (données personnelles) | non | non | non |

Aucune écriture directe sur les tables, même pour `service_role` : tout passe par les fonctions (quota « contacts » du plan, audit, rôles relus par la base). Lecture : RLS par rôle et par entreprise.

## Fonctions SQL (surface PostgREST, `SECURITY DEFINER`, `search_path` vide, aucun droit pour `anon` ni `service_role`)
`create_contact(p_org, p_name, p_email_raw, p_email_normalized, p_phone_e164, p_language, p_country, p_external_source, p_external_id, p_attributes)` · `update_contact(p_org, p_id, …)` · `record_consent(p_org, p_contact, p_channel, p_purpose, p_source, p_proof)` · `revoke_consent(p_org, p_contact, p_channel, p_purpose, p_do_not_contact)` (renvoie le nombre de consentements révoqués) · `set_do_not_contact(p_org, p_contact, p_value)`.

Codes d'erreur : `28000` non authentifié · `42501` interdit · `22023` / `23514` valeur invalide · `PT404` introuvable (contact d'une autre entreprise compris) · `23505` doublon (e-mail, téléphone ou identifiant externe déjà pris, course comprise) · `P0001 quota_exceeded` · `subscription_inactive`.

## Service web (`apps/web/lib/contacts`)
- `createContact(supabase, organizationId, input)` : cherche les contacts de l'entreprise de même e-mail ou téléphone (`.eq()`), applique la règle de domaine `findDuplicate`, puis appelle la fonction SQL.
  - un seul contact correspond : renvoyé tel quel (`created: false`, **aucune fusion des données**) ;
  - l'e-mail d'un contact et le téléphone d'un **autre** : `conflict` avec les identifiants (revue manuelle, aucune table de file de revue au J18) ;
  - course perdue (23505) : le contact gagnant est repris.
- `updateContact`, `recordConsent`, `revokeConsent`, `setDoNotContact` : même pipeline, entreprise du **contexte vérifié** (jamais l'entrée).
- Lectures (`queries.ts`) : `listContacts`, `getContact`, `findContactsByKeys`, `listConsentEvents`, avec les droits de l'utilisateur.

## Normalisation (`packages/domain/src/contacts`)
- E-mail : ASCII, minuscules, 254 caractères, local ≤ 64, pas de point en bordure ni double ; la base re-contrôle `email_normalized = lower(btrim(email_raw))`. Domaines internationaux en punycode.
- Téléphone : `libphonenumber-js`, format E.164. Numéro national : pays par défaut (`default_country`, sinon le pays du contact). `00…` et `+…` sont lus tels quels. Exemples validés : `06 12 34 56 78` (MA) → `+212612345678` ; `050 123 4567` (SA) → `+966501234567`.

## Règles issues de la revue sécurité (J18)
- **Identité d'un contact « ne plus contacter »** : seuls owner et admin peuvent changer son e-mail, son téléphone ou son identifiant externe (sinon l'ancien identifiant se libérerait pour un nouveau contact sans restriction). Le marketing peut encore modifier le reste.
- **Un consentement vaut pour une adresse** : si l'e-mail change, les consentements `email` actifs sont révoqués ; si le téléphone change, ceux de `whatsapp` aussi (audit `consent.revoked`).
- **Canal cohérent** : un consentement `email` exige un e-mail sur le contact, `whatsapp` un téléphone.
- **Plafond** : 50 consentements (historique compris) par contact, l'historique étant non purgeable.
- **Caractères** : e-mail saisi en ASCII imprimable (le signe Kelvin devient « k » en minuscules) ; clés et valeurs d'`attributes` sans caractère de contrôle ni de direction.
- **Contrôle final d'envoi (J31+)** : il doit lire `consent_events` par (contact, canal, finalité, non révoqué) **et** `do_not_contact`, jamais `consent_status` seul (statut global, pratique pour filtrer, pas pour décider).

## Audit
`contact.created`, `contact.updated` (noms des champs modifiés), `contact.do_not_contact_changed`, `consent.recorded` (contact, canal, finalité, source), `consent.revoked`. **Jamais** le nom, l'e-mail, le téléphone ni la preuve.

## Écran Contacts (J30b)
Pages `/contacts` (liste) et `/contacts/[id]` (fiche). **Rôles** : owner, admin et marketing ; le commercial et l'analyste sont renvoyés au tableau de bord (données personnelles) ; un contact d'une autre entreprise ou un identifiant invalide donne 404. Le lien du menu n'apparaît que pour ces rôles (commodité d'affichage : la page et la RLS décident).
- **Liste** : recherche (nom, e-mail, téléphone) et pagination (25 par page) côté serveur par `search_contacts(p_org, p_query, p_limit, p_offset)` : fonction **SECURITY INVOKER** (la RLS de `contacts` s'applique à l'appelant ; filtre d'entreprise explicite), saisie **échappée** (`%`, `_`, `\` ne sont jamais des motifs), recherche de téléphone par chiffres, limite de 1 à 200, total renvoyé avec chaque ligne. Migration `20261208100000_contacts_search.sql` (retour arrière : `supabase/rollbacks/20261208100000_contacts_search.sql`). Colonnes : contact, e-mail, téléphone, statut du consentement, « ne plus contacter », date de création.
- **Fiche** : coordonnées, statut dérivé, historique de `consent_events` (canal, finalité, date, source, état actif ou retiré le …) avec la **preuve** : texte présenté et version. **L'adresse IP et l'URL conservées dans la preuve ne sont jamais affichées.**
- **Formulaires** (Server Actions, `withAction` : zod, contexte tenant relu en base, `organization_id` comparé, `can()`, limitation de débit, **clé d'idempotence obligatoire**) :
  - `contacts.consent.record` : canal, finalité (marketing, lettre d'information), source (saisi à la main, téléphone, en personne, formulaire papier), texte et version facultatifs ; permission `contacts` / `create` ; la preuve se limite au texte et à la version ;
  - `contacts.consent.revoke` : canal, finalité (ou toutes), case « bloquer aussi » ; permission `consent` / `revoke` ; effet immédiat ;
  - `contacts.do_not_contact.set` : pose ou lève le blocage ; permission `consent` / `mark_do_not_contact` ; le bouton « lever » n'est proposé qu'à owner et admin et la base le revérifie (marketing : refus).
  Chaque action rappelle les fonctions SQL de J18 (`record_consent`, `revoke_consent`, `set_do_not_contact`) : rôle relu par la base, quota, audit (`consent.recorded`, `consent.revoked`, `contact.do_not_contact_changed`) **sans donnée personnelle**.
- **Pas de création de contact ni de lead dans cet écran** : la création arrive avec la fiche lead (J30c, J30d) ; aucune route d'API REST n'a été ajoutée (Server Actions, comme l'écran Projets).

## Limites connues
- **Journaux Postgres** : une violation d'unicité ou de contrainte écrit la valeur fautive dans le DETAIL du journal du serveur de base (jamais renvoyée au client). En production : `log_error_verbosity = terse` ou filtrage des journaux (à traiter avec l'hébergement, ADR 010).
- **Décisions d'architecture soumises à la responsable technique** : (1) table de suppression d'identifiants alimentée quand `do_not_contact` passe à vrai (aujourd'hui, un owner ou admin peut encore libérer l'identifiant d'un contact « ne plus contacter ») ; (2) fonction SQL unique `can_contact(org, contact, canal, finalité)` pour le contrôle final d'envoi.
- Le contrôle final avant envoi (spec §9.3 : consentement, `do_not_contact`, template) et l'arrêt des tâches en attente arrivent avec les canaux (J31 et suivants) : `revoke_consent` prend effet dans la base immédiatement, le worker relira l'état à l'envoi.
- Pas de suppression de contact (preuves de consentement) ; l'effacement à la demande est un sujet de conformité à instruire.
- La liste de suppression (rebonds, plaintes, désinscriptions, `suppressions` — ADR 007 G-D5) vient avec l'e-mail (J31–33).
