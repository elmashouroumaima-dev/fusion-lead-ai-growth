# supabase/

Schéma, migrations et RLS (spec §6, §7). Rien avant J5 : `config.toml` (Supabase CLI) au J5, premières migrations au J6.

- `migrations/` : migrations horodatées, jamais modifiées après application (ADR 006).
- `rollbacks/` : scripts de retour associés à chaque migration (ADR 006).
- `tests/` : tests RLS (ADR 005, `docs/testing/strategy.md`).
