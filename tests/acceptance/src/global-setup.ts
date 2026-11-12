import { psql } from "../../../supabase/tests/rls/src/harness";

/**
 * Nettoyage de la base LOCALE après les scénarios : les requêtes d'API et d'actions laissent des clés d'idempotence et des
 * seaux de limitation de débit, or les tests pgTAP de la couche service (`050_service_layer`) supposent ces deux tables vides.
 * (Les lignes expirent d'elles-mêmes ; ceci évite un échec trompeur de `pnpm test:db` lancé juste après.)
 */
function clean(): void {
  try {
    psql("delete from public.idempotency_keys; delete from public.rate_limit_buckets;");
  } catch {
    // Docker indisponible : sans conséquence pour les scénarios, `pnpm db:reset` remet la base à zéro.
  }
}

export default function setup(): () => void {
  clean();
  return clean;
}
