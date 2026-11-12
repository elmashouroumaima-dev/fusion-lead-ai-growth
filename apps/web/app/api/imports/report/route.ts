import { buildImportReportCsv, uuidSchema } from "@fusion-leap/domain";
import { getImportReport } from "../../../../lib/imports/service";
import { ServiceError } from "../../../../lib/service/errors";
import { withRoute } from "../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

const reportSchema = {
  safeParse(input: unknown) {
    const parsed = uuidSchema.safeParse((input as { batch_id?: unknown } | null)?.batch_id);
    return parsed.success ? { success: true as const, data: { batchId: parsed.data } } : { success: false as const, error: { issues: [] } };
  },
};

/**
 * Rapport téléchargeable d'un import : `GET /api/imports/report?batch_id=<uuid>` -> CSV `row,outcome,reason,lead_created` (un numéro de
 * ligne du fichier, un résultat et un motif en code ; AUCUNE donnée de contact). Owner et admin ; lot d'une autre entreprise : 404.
 */
export const GET = withRoute(
  {
    name: "imports.report",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: "none",
    permission: { action: "create", resource: "projects" },
    schema: reportSchema,
  },
  async (ctx, input) => {
    const report = await getImportReport(ctx.supabase, ctx.organizationId, input.batchId);
    if (!report) throw new ServiceError("not_found");
    return {
      status: 200,
      text: buildImportReportCsv(report.rows),
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="import-${input.batchId}.csv"` },
    };
  },
);
