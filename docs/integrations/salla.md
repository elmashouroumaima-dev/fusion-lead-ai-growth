# Intégration — Salla

- **Spec :** §4.2, §4.3, §9.4, §14 Q4, §15 ; hypothèse §14 confirmée : **mode marketing, sans lecture de boutique**.
- **Consultée le :** 2026-11-05. Ce qui n'a pas pu être vérifié est marqué **À CONFIRMER**.

## Deux usages strictement séparés (spec §9.4)
1. **Marketing interne des apps/thèmes de Fusion Leap** (projets `salla_app`, `salla_theme`) : aucune permission boutique, aucun appel à l'API Salla. C'est le seul périmètre actif au MVP.
2. **Données d'une boutique marchande réelle** : exige une app, une autorisation OAuth, des scopes explicites. **Hors MVP** (option J55 sous feature flag désactivé).

## OAuth (usage 2 uniquement)
Source : https://docs.salla.dev/doc-421118
- Endpoints : autorisation `https://accounts.salla.sa/oauth2/auth` ; jeton (échange et refresh) `https://accounts.salla.sa/oauth2/token` ; infos utilisateur `https://accounts.salla.sa/oauth2/user/info` ; API `https://api.salla.dev/admin/v2/` avec `Authorization: Bearer`.
- **Access token : 14 jours.** **Refresh token** (scope `offline_access`) : **1 mois**, **à usage unique** : chaque refresh en renvoie un nouveau et invalide l'ancien ; réutiliser un refresh token peut invalider les jetons associés et impose de **réinstaller l'app**. La doc recommande un **verrou (mutex)** autour du refresh. → notre adaptateur : refresh sous verrou par (organisation, boutique), mise à jour atomique du `secret_ref`, refresh proactif.
- **Easy Mode** (recommandé) : Salla fait l'échange de code et envoie les jetons au webhook via l'événement `app.store.authorize` ; à chaque mise à jour de l'app, `app.store.authorized` fournit de nouveaux jetons à enregistrer. **Custom Mode** : redirection et échange à notre charge. La doc indique que **Easy Mode est la seule méthode autorisée pour les apps publiées** sur l'App Store ; Custom Mode sert aux tests. → un connecteur de production implique de traiter des jetons reçus **par webhook** (donc stockés via ADR 004 dès réception).
- Scopes définis dans le Partners Portal (ex. `orders.read_write`, `customers.read_write`) ; scopes minimaux uniquement.

## Webhooks
Sources : https://docs.salla.dev/doc-421119 et https://docs.salla.dev/partner-apis/app-events
- **Vérification** : stratégie par défaut des Partner Apps = `X-Salla-Security-Strategy: Signature` avec `X-Salla-Signature` = HMAC-SHA256 du corps avec le secret, comparaison à temps constant. Stratégie `Token` possible ; la doc est **incohérente** sur l'en-tête qui porte le jeton (`Authorization` ou `x-salla-signature`) → **À CONFIRMER** sur un envoi réel au J55.
- **Événements d'app** : `app.store.authorize`, `app.installed`, `app.updated`, `app.uninstalled`, `app.trial.*`, `app.subscription.*`, `app.feedback.created`, `app.settings.updated`. Les événements commande/produit/client/etc. existent aussi (liste de la page webhooks, qui n'énumère pas `app.installed`).
- **Charge utile** : `event`, `merchant`, `created_at`, `data`. `merchant` identifie le marchand ; la page **ne définit pas de champ `store_id` distinct** → le mapping boutique ↔ organisation repose sur `merchant` (**À CONFIRMER** : différence éventuelle entre `merchant` et `store_id`).
- **Reprises** : délai de réponse ~30 s ; **3 reprises à ~5 minutes** d'intervalle si pas de succès → déduplication nécessaire.
- **Désinstallation** (`app.uninstalled`) : la page ne prescrit aucune action ; notre politique : arrêt immédiat de la synchro, révocation du `secret_ref`, conservation/suppression selon la politique de rétention de l'entreprise (à définir en ADR avec Q5).
- **Tenant** : résolu par `merchant` → `salla_stores`/`integrations.external_account_id` (jamais par champ libre du payload), via le pipeline `/api/webhooks/salla` (J29).

## Limites de débit
Non vérifiées dans les pages consultées → **À CONFIRMER** (J55) avant tout appel d'API.

## Conformité / données
Aucun chiffre de boutique (installation, achat, revenu) n'est affiché comme confirmé s'il ne vient pas d'une donnée autorisée par les scopes (spec §9.4, §10).

## Comptes de test
Compte Partenaire Salla + app de test + boutique de démonstration : à créer par la responsable technique, **seulement si l'option J55 (OAuth sandbox) est retenue**. L'éligibilité partenaire/publication/encaissement est la question Q4 (sans réponse : hypothèse §14).

## Plan B
Mode marketing seul (déjà le périmètre MVP) ; pas de dépendance à l'agrément Salla. Backlog post-MVP : connecteur marchand.
