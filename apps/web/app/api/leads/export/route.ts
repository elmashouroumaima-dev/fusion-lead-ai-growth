import { buildLeadsExportCsv, hasInvalidLeadListParams, parseLeadListParams } from "@fusion-leap/domain";
import { exportLeads } from "../../../../lib/crm/service";
import { ServiceError } from "../../../../lib/service/errors";
import { withRoute } from "../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/**
 * Export CSV des leads (J24, spec §11, ADR 014) : `GET /api/leads/export?project=&stage=&source=&assignee=&unassigned=1&q=&sort=`.
 * Mêmes filtres que la liste, 10 000 lignes au plus, entreprise du contexte, RLS de l'utilisateur. Rôles : owner et admin (la base le
 * revérifie ; marketing, commercial et analyste : 403). Un export est AUDITÉ (`export.created` : nombre de lignes et noms des filtres,
 * jamais leurs valeurs) AVANT l'envoi du fichier. Cellules neutralisées contre l'injection de formule.
 */
const exportSchema = {
  safeParse(input: unknown) {
    const { fetchSite, ...query } = (input ?? {}) as Record<string, string | null>;
    // Revue sécurité : un GET qui écrit un audit et consomme un jeton ne doit pas être déclenché depuis un autre site (navigation
    // de premier niveau avec le cookie de session) ; un paramètre de filtre présent mais invalide est refusé (pas d'export « tout »).
    if (fetchSite === "cross-site" || hasInvalidLeadListParams(query as Record<string, string>)) return { success: false as const, error: { issues: [] } };
    return { success: true as const, data: parseLeadListParams(query as Record<string, string>).filters };
  },
};

export const GET = withRoute(
  {
    name: "leads.export",
    auth: "tenant",
    rateLimit: "sensitive",
    idempotency: "none",
    permission: { action: "export", resource: "exports" },
    schema: exportSchema,
    input: (query, headers) => ({ ...(query as object), fetchSite: headers.get("sec-fetch-site") }),
  },
  async (ctx, filters) => {
    const result = await exportLeads(ctx.supabase, ctx.organizationId, filters);
    if (!result.ok) throw new ServiceError(result.code);
    const date = new Date().toISOString().slice(0, 10);
    return {
      status: 200,
      text: buildLeadsExportCsv(result.value),
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="leads-${date}.csv"` },
    };
  },
);
