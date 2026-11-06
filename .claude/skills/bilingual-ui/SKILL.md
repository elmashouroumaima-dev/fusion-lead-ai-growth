---
name: bilingual-ui
description: Règles pour écrire de l'UI bilingue arabe (RTL) / anglais dans Fusion Leap (next-intl, ADR 011). À utiliser pour tout écran, composant ou message affiché à l'utilisateur.
---

# UI bilingue AR/EN

- Locales : `fr` (défaut, `dir="ltr"`), `ar` (`dir="rtl"`) et `en` (`dir="ltr"`). Source unique : `LOCALES` / `DEFAULT_LOCALE` dans `packages/domain`. `<html lang dir>` posé côté serveur selon la locale.
- **Aucune chaîne en dur** dans les composants : tout passe par `messages/{fr,ar,en}.json` ; mêmes clés dans les trois fichiers (un test le vérifie).
- **CSS logique uniquement** : `margin-inline-start`, `padding-inline`, `inset-inline-*`, `text-align: start`. Interdit : `left`, `right`, `margin-left`, `padding-right`, `float`.
- Icônes directionnelles (flèches, chevrons) : à inverser en RTL.
- Dates, nombres, devises : `Intl` avec la locale active.
- Formulaires : `<label>` associé, `autocomplete` correct, messages d'erreur annoncés (`aria-live`), focus visible.
- Les e-mails et messages d'erreur d'auth sont traduits mais **génériques** (voir secure-auth-review).
- Valider visuellement `fr`, `ar` ET `en` avant de conclure.
