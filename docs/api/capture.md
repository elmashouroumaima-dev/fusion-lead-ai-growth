# Capture publique de leads (J21)

Migration `20261123100000_form_keys_capture.sql` (retour arrière : `supabase/rollbacks/20261123100000_form_keys_capture.sql`). Spec §9.1 et §13-3, ADR 007 (`form_keys`). Première route **publique** (sans session) de l'application.

## Contrat du formulaire d'un site
```
POST /api/leads
Content-Type: application/json
Origin: https://exemple.ma            (ajouté par le navigateur)
X-Form-Key: flk_<64 caractères hexadécimaux>

{
  "name": "Nadia Benali",
  "email": "nadia@exemple.ma",
  "phone": "06 12 34 56 78", "default_country": "MA",
  "language": "fr", "country": "MA",
  "utm": { "utm_source": "newsletter", "utm_campaign": "ete", "landing_page_id": "lp-ete" },
  "consent": { "channel": "email", "purpose": "marketing" | "newsletter", "text": "J'accepte de recevoir des offres…", "version": "v2" },
  "page_url": "https://exemple.ma/inscription",
  "website": ""                         (champ piège : à laisser VIDE, invisible pour un humain)
}
→ 202 { "status": "received" }
```
- **Entreprise et projet sont déduits de la clé** : un corps qui les nomme (ou contient un champ inconnu) est refusé (400).
- Au moins un identifiant (`email` ou `phone`) ; un numéro national exige `default_country` (ou `country`) ; e-mail en ASCII ; texte et version du consentement **obligatoires ensemble** ; `page_url` en https ; corps de **16 Kio** au plus ; JSON strict.
- La clé est un secret **de formulaire** : elle est visible dans la page. Ce qui la protège : les **origines autorisées**, la limitation de débit, et la possibilité de la **révoquer**.

## Réponses
| Statut | Cas |
|---|---|
| `202 { status: "received" }` | soumission acceptée ; **identique** pour un nouveau contact et un doublon (aucun identifiant, aucune indication « déjà connu ») ; champ piège rempli : même réponse, rien n'est écrit |
| `400 validation_failed` | corps invalide, champ inconnu, entreprise ou projet nommés |
| `403 forbidden` | clé absente, mal formée, inconnue, révoquée ; origine absente ou qui n'est pas celle **de cette clé** ; projet archivé (**un seul refus**, sans indiquer la cause, sans en-tête CORS) |
| `413 payload_too_large` | corps de plus de 16 Kio |
| `429 rate_limited` + `Retry-After` | limitation de débit (par adresse : 20 en rafale puis 20 par minute ; par clé : 200 en rafale puis 2 par seconde) |
| `429 quota_exceeded` | quota « contacts » ou abonnement inactif |
| `503 service_unavailable` | limiteur indisponible (échec fermé) |

Erreurs normalisées `{ code, message, request_id }`. **CORS** : `OPTIONS /api/leads` (préflight, limité à 60 en rafale puis 1 par seconde et par adresse, AVANT toute lecture de la base) répond 204 pour une origine autorisée par au moins une clé active d'un projet actif (`Access-Control-Allow-Origin` = cette origine, `Vary: Origin`, jamais d'identifiants) ; origine inconnue ou absente : 403 sans en-tête CORS. Pour un `POST`, les en-têtes CORS ne sont posés qu'une fois la clé reconnue ET son origine vérifiée.

## Ce que fait la route puis la base
Ordre de la route : origine présente → limitation par **adresse** → forme de la clé → **clé active ET origine de cette clé** (`form_key_origin_ok`, aucune écriture) → limitation par **clé** (seulement pour une clé qui existe : aucune ligne créée pour une clé inventée) → corps → champ piège → `capture_lead`. L'adresse du visiteur est l'élément de `x-forwarded-for` à `TRUSTED_PROXY_HOPS` rangs en partant de la **droite** (chaque proxy y ajoute l'adresse qu'il voit ; la gauche est forgeable), sans port, IPv6 regroupée par /64 pour la limitation.

### `capture_lead` (une transaction)
1. **Clé** : l'empreinte SHA-256 donne l'entreprise et le projet ; clé inactive, origine hors liste, projet archivé : `form_key_invalid`.
2. **Contact** : retrouvé par **e-mail**, sinon par **téléphone** ; sinon créé (quota « contacts »). Conflit (e-mail d'un contact, téléphone d'un autre) : rattachement au contact de l'e-mail, **sans toucher** au téléphone ; aucune fusion de données.
3. **Lead** : le lead encore **ouvert** du même contact et du même projet est **réutilisé** ; nouveau lead seulement si l'ancien est gagné ou perdu. Source `web_form`, étape « non assigné », UTM et `landing_page_id` stockés. La ligne du contact est verrouillée : deux soumissions simultanées donnent un contact et un lead.
4. **Consentement** : finalités admises `marketing` et `newsletter` ; enregistré (texte, version, page, IP dans `proof`, source `web_form`) seulement s'il vise l'adresse **stockée sur le contact** ; déjà actif pour le même canal et la même finalité : sans effet ; **jamais après une révocation** sur ce canal (la voie publique ne réactive pas un contact qui s'est désinscrit, adresse non vérifiée).
   Un contact « **ne plus contacter** » ne reçoit **ni nouveau lead, ni job, ni consentement** : la soumission est acceptée sans effet.
5. **Job** `lead.assign` (identifiant du lead seulement) à la création d'un lead ; traité au J22 (handler provisoire sans effet : le lead reste dans la file « non assignés »).

## Clés de formulaire (owner et admin)
`create_form_key(p_org, p_project, p_origins)` renvoie la clé **en clair une seule fois** (`{ id, key, key_prefix }`) ; la base ne conserve que l'**empreinte**. `set_form_key_active` révoque / réactive ; `set_form_key_origins` change les origines. Origines : 1 à 10, https exactes en minuscules (sans chemin, joker, adresse IP ni hôte interne) ; **5 clés actives** au plus par projet ; une clé ne se supprime pas. Lecture : owner et admin, **sans** l'empreinte (`key_prefix` suffit pour la reconnaître). Service web : `apps/web/lib/forms/service.ts`. Pas d'écran (J24).

## Audit et journaux
`form_key.created / revoked / activated / updated` (préfixe et noms de champs) ; `contact.created`, `lead.created`, `consent.recorded` avec l'acteur « système ». **Jamais** de clé, d'e-mail, de nom, de téléphone, de texte de consentement ni d'IP dans l'audit ni dans les journaux de la route (seuls des booléens et l'identifiant de requête).

## Limites connues
- **Pas de double opt-in** : la spec n'en prévoit pas ; un consentement saisi sur le formulaire est enregistré tel quel. Quiconque connaît la clé peut soumettre l'adresse d'un tiers avec une case cochée. À traiter avec l'e-mail (J31–33) : confirmation avant tout envoi marketing.
- **`Origin` est forgeable hors navigateur** : la vérification d'origine protège contre l'usage de la clé par un autre SITE (navigateur), pas contre un script qui forge l'en-tête ; la limitation de débit et la révocation limitent ce risque. Le préflight révèle si une origine est cliente de la plateforme (204 / 403), comme tout CORS.
- **Adresse du visiteur** : `TRUSTED_PROXY_HOPS` (1 par défaut ; 0 = ignorer l'en-tête) doit correspondre au nombre réel de reverse proxys qui AJOUTENT l'adresse à `x-forwarded-for` (ADR 010) ; une adresse absente ou illisible partage le seau « unknown ». À régler et tester à l'hébergement.
- **Déni de service du quota « contacts »** : la clé est publique ; le seau par adresse (20 puis 20 par minute) et par clé (200 puis 2 par seconde) ralentit sans empêcher un attaquant disposant de plusieurs adresses de remplir le quota d'une entreprise ou d'épuiser le seau de sa clé. Mitigations à décider (nouvelle dépendance ou nouveau quota) : défi anti-robot côté serveur, quota de captures publiques par clé et par jour, contacts « en attente de confirmation » comptés après confirmation. La clé se révoque immédiatement (`set_form_key_active`).
- **Oracle résiduel au quota plein** : quand le quota « contacts » est atteint, un contact existant continue de passer (202) alors qu'un nouveau reçoit 429 `quota_exceeded` (idem 409 à 50 leads pour un contact) : un attaquant qui remplit lui-même le quota pourrait tester si une adresse est déjà dans le CRM. Décision de produit à confirmer : répondre 202 aussi (et alerter l'entreprise, J22) ou garder le 429 honnête.
- **Purge des seaux** : `rate_limit_purge` n'est pas encore planifiée avec le worker ; à planifier avant la mise en ligne publique (la table croît avec les adresses).
- **Preuve de consentement** : texte, version et `page_url` sont ceux envoyés par le site (non contrôlés par le serveur) ; aucune clé de formulaire n'est enregistrée sur le lead (impossible aujourd'hui de purger les leads d'une clé abusée par clé).
- **Job `lead.assign`** (J22) : le handler devra relire le lead avec l'entreprise de la **ligne du job** et ne pas se fier à la seule charge utile.
- Pas d'Idempotency-Key (formulaire public) : le modèle de données dédoublonne.
- Le traitement des jobs `lead.assign` (règles d'assignation, file « non assignés », alerte au manager) est le J22.
