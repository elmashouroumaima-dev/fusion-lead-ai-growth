# UI CRM : leads, deals, export (J24)

Migration `20261126100000_crm_search_export.sql` (retour arrière : `supabase/rollbacks/20261126100000_crm_search_export.sql`). Plan J24, spec §5.3 et §11, ADR 014 (lecture des leads, export). Écrans en français, arabe (RTL) et anglais.

## Écrans
### `/leads` : liste des leads
- Filtres : projet, étape, source, responsable (owner et admin), « non assignés » (raccourci « file »), tri (récents, anciens, modifiés, nom). Recherche sur le **nom, l'e-mail et le téléphone** du contact (téléphone national `06…` ou international `+212…` : seuls les chiffres comptent, zéros de tête ignorés).
- Un formulaire **GET** : tout est dans l'URL (lien partageable, bouton Précédent). Les paramètres sont revalidés côté serveur : une valeur invalide est ignorée (retour au défaut).
- Pagination **côté serveur** : 25 par page, total affiché, page au-delà du total : le total est relu pour garder la navigation.
- Rôles : owner, admin et marketing voient **tous** les leads, le commercial **les siens**, l'analyste est renvoyé au tableau de bord (PII). `Referrer-Policy: no-referrer` et `no-store` sur cette page (la recherche peut contenir une adresse ou un téléphone).

### `/deals` : tableau par étape
- Colonnes = étapes du pipeline par défaut (hors « non assigné »), nombre de deals et total par devise. Filtre par projet. 500 deals les plus récents au plus.
- **Déplacer** : glisser-déposer OU menu « Déplacer vers… » de la carte (clavier et lecteurs d'écran), puis `POST /api/deals/move`. Mise à jour optimiste annulée si le serveur refuse ; notification et message écrit dans la page ; annonce `aria-live`.
- Déplacement : owner, admin et commercial **sur ses propres deals** (ADR 014 ligne 14) ; marketing en lecture seule (aucune carte déplaçable). La base revérifie rôle et propriété (un deal d'un autre commercial est « introuvable »).

## API
### `GET /api/leads/export?project=&stage=&source=&assignee=&unassigned=1&q=&sort=`
CSV `lead_id,created_at,name,email,phone,source,stage,assignee_id,project_id` (BOM UTF-8, CRLF), **mêmes filtres que la liste**, entreprise du contexte, RLS de l'utilisateur.
- Rôles : **owner et admin** ; marketing, commercial, analyste : 403 ; sans session : 401.
- **Audité** : `export.created` (nombre de lignes et **noms** des filtres, jamais leurs valeurs) écrit **avant** l'envoi du fichier : sans audit, pas d'export.
- 10 000 lignes au plus ; **plus de résultats : 413** (affiner les filtres), jamais de fichier tronqué en silence.
- Un paramètre de filtre présent mais invalide : **400** (pas d'export « tout »). Navigation inter-sites (`Sec-Fetch-Site: cross-site`) : 400. Limite de débit « sensitive ».
- **Injection de formule** : une cellule qui commence par `=`, `+`, `-`, `@`, tabulation ou retour chariot, y compris après des espaces ou des caractères invisibles, est préfixée d'une apostrophe ; un numéro E.164 (`+` et 6 à 15 chiffres) reste intact.

### `POST /api/deals/move` `{ deal_id, stage_id }`
`Idempotency-Key` obligatoire ; l'entreprise vient du contexte (un `organization_id` dans le corps doit lui être égal) ; réponse 200 `{ deal }`. Erreurs : 400, 403 (marketing, analyste), 404 (deal d'une autre entreprise ou d'un autre commercial), 409 (étape d'un autre pipeline), 429.

## Base
- `public.search_leads(p_org, p_project, p_stage, p_source, p_assignee, p_unassigned, p_query, p_sort, p_limit, p_offset)` : **SECURITY INVOKER** (la RLS de l'appelant s'applique), renvoie lead, étape, contact et `total_count`. `p_limit` 1 à 10 000, `p_offset` 0 à 1 000 000, recherche 100 caractères au plus, tri sur liste blanche, source bornée. Les caractères `%`, `_` et `\` de la recherche sont **échappés** (`private.like_escape`).
- Index trigrammes (`pg_trgm`) sur nom, e-mail et téléphone des contacts ; index `leads (organization_id, created_at desc, id)`.
- `public.log_export(p_org, p_kind, p_count, p_filters)` : owner et admin ; type `leads` ; seuls les **noms** de filtres connus sont conservés.

## Limites connues
- **« Export » est une fonction d'interface auditée, pas une barrière de lecture** : la RLS accorde déjà la lecture des leads et contacts au marketing ; un marketing peut lire en volume par `rpc/search_leads` (ou `select` sur `contacts`) sans audit, et un owner ou admin peut contourner l'export. `log_export` ne recompte rien. À décider avec la responsable technique (plafond de volume hors export, audit des lectures en masse).
- Pas de fiche détaillée d'un lead (chronologie, notes, tâches) ni d'édition de leads ou de pipelines à l'écran ; pas de glisser-déposer tactile garanti (le menu « Déplacer vers… » couvre le mobile).
- Responsable affiché par un identifiant court (« Membre 000004 ») : les noms des membres viendront avec un profil.
- La recherche ne fait pas abstraction des accents (« Hélène » ≠ « Helene »).
- Les journaux d'accès de l'hébergeur voient `?q=` (nom, e-mail ou téléphone cherché) : à documenter au runbook.
- Pas de limite de débit sur la liste (seule la route d'export en a une).
