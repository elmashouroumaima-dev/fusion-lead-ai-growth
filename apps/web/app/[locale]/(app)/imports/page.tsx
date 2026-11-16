import { localeSchema } from "@fusion-leap/domain";
import { can } from "@fusion-leap/permissions";
import { getFormatter, getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ImportBatches, type BatchView } from "../../../../components/imports/import-batches";
import { ImportWizard } from "../../../../components/imports/import-wizard";
import { requireLocale } from "../../../../i18n/require-locale";
import { requireClaims } from "../../../../lib/auth/require-claims";
import { listImportBatches } from "../../../../lib/imports/service";
import { listProjects } from "../../../../lib/projects/queries";
import { createClient } from "../../../../lib/supabase/server";
import { requireTenantContext } from "../../../../lib/tenant/context";

export const dynamic = "force-dynamic";

/**
 * Import CSV de leads (J39c, spec §9.1) : assistant en trois étapes et suivi des lots. Owner et admin seulement (comme l'API : les autres rôles
 * reviennent au tableau de bord ; la base et les routes revérifient). La page ne lit jamais le chemin du fichier ni le mapping d'un lot.
 */
export default async function ImportsPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = localeSchema.parse(await requireLocale(params));
  const t = await getTranslations({ locale, namespace: "Imports" });
  await requireClaims(locale);
  const ctx = await requireTenantContext(locale);
  if (!can(ctx.role, "create", "projects")) redirect(`/${locale}/dashboard`);

  const format = await getFormatter({ locale });
  const supabase = await createClient();
  let data: { projects: { id: string; name: string }[]; batches: BatchView[] } | null = null;
  try {
    const [projects, batches] = await Promise.all([listProjects(supabase, ctx.organizationId, { status: "active" }), listImportBatches(supabase, ctx.organizationId, 20)]);
    const names = new Map(projects.map((project) => [project.id, project.name]));
    data = {
      projects: projects.map((project) => ({ id: project.id, name: project.name })),
      batches: batches.map((batch) => ({
        id: batch.id,
        status: batch.status,
        projectName: names.get(batch.project_id) ?? null,
        rowCount: batch.row_count,
        created: batch.created_count,
        matched: batch.matched_count,
        skipped: batch.skipped_count,
        errors: batch.error_count,
        errorCode: batch.error_code,
        dateLabel: format.dateTime(new Date(batch.created_at), { dateStyle: "medium", timeStyle: "short" }),
      })),
    };
  } catch {
    data = null;
  }

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-5xl gap-6">
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground max-w-prose text-sm">{t("description")}</p>
      </header>
      {data === null ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t("errors.generic")}</AlertDescription>
        </Alert>
      ) : (
        <>
          <Card>
            <CardHeader>
              <h2 className="text-lg font-medium">{t("wizardTitle")}</h2>
            </CardHeader>
            <CardContent>
              {data.projects.length === 0 ? <p className="text-muted-foreground text-sm">{t("noProject")}</p> : <ImportWizard projects={data.projects} />}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <h2 className="text-lg font-medium">{t("batches.title")}</h2>
            </CardHeader>
            <CardContent>
              <ImportBatches batches={data.batches} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
