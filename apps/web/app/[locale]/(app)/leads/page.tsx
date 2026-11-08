import { leadListQuery, localeSchema, parseLeadListParams, type PipelineStageRow } from "@fusion-leap/domain";
import { can } from "@fusion-leap/permissions";
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, InboxIcon } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { LeadFilters } from "../../../../components/crm/lead-filters";
import { LeadTable } from "../../../../components/crm/lead-table";
import { Link } from "../../../../i18n/navigation";
import { requireLocale } from "../../../../i18n/require-locale";
import { requireClaims } from "../../../../lib/auth/require-claims";
import { searchLeads } from "../../../../lib/crm/service";
import { listPipelines, listStages } from "../../../../lib/leads/queries";
import { listOrganizationMembers } from "../../../../lib/members/queries";
import { listProjects } from "../../../../lib/projects/queries";
import { createClient } from "../../../../lib/supabase/server";
import { requireTenantContext } from "../../../../lib/tenant/context";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const KNOWN_SOURCES = ["web_form", "csv_import", "manual"] as const;
const shortIdOf = (userId: string): string => userId.replace(/-/g, "").slice(-6).toUpperCase();

/**
 * Liste des leads de l'entreprise active : filtres (projet, étape, source, responsable, « non assignés »), recherche (nom, e-mail,
 * téléphone) et pagination CÔTÉ SERVEUR par `search_leads` (SECURITY INVOKER : la RLS décide de ce qui est visible). Rôles : owner,
 * admin et marketing voient tous les leads, le commercial les siens ; l'analyste est renvoyé au tableau de bord (PII). L'export CSV
 * est réservé à owner et admin.
 */
export default async function LeadsPage({ params, searchParams }: Props) {
  const locale = localeSchema.parse(await requireLocale(params));
  const t = await getTranslations({ locale, namespace: "Crm" });
  await requireClaims(locale);
  const ctx = await requireTenantContext(locale);
  if (!can(ctx.role, "read", "leads", { isOwnRecord: true })) redirect(`/${locale}/dashboard`);

  const { filters, page } = parseLeadListParams(await searchParams);
  const supabase = await createClient();
  const canExport = can(ctx.role, "export", "exports");
  const ownOnly = !can(ctx.role, "read", "leads");

  const loaded = await Promise.all([
    searchLeads(supabase, ctx.organizationId, filters, page),
    listProjects(supabase, ctx.organizationId),
    listPipelines(supabase, ctx.organizationId).then((pipelines) => {
      const pipeline = pipelines.find((item) => item.is_default) ?? pipelines[0];
      return pipeline ? listStages(supabase, ctx.organizationId, pipeline.id) : ([] as PipelineStageRow[]);
    }),
    canExport ? listOrganizationMembers(ctx) : Promise.resolve([]),
  ]).then(
    (value) => value,
    () => null,
  );

  const format = await getFormatter({ locale });
  const sources = [...new Set<string>([...KNOWN_SOURCES, ...(filters.source ? [filters.source] : [])])];
  const filtered = Object.keys(filters).some((key) => {
    const value = filters[key as keyof typeof filters];
    return key === "sort" ? value !== "created_desc" : Boolean(value);
  });

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-6xl gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="grid gap-1">
          <h1 id="leads-title" className="text-2xl font-semibold tracking-tight">
            {t("leads.title")}
          </h1>
          <p className="text-muted-foreground max-w-prose text-sm">{t("leads.description")}</p>
          {ownOnly ? <p className="text-muted-foreground text-xs">{t("leads.ownOnlyHint")}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant={filters.unassigned ? "secondary" : "outline"}>
            <Link href={`/leads?${leadListQuery({ ...filters, unassigned: !filters.unassigned })}`} aria-pressed={filters.unassigned}>
              <InboxIcon aria-hidden="true" />
              {filters.unassigned ? t("leads.queueActive") : t("leads.queue")}
            </Link>
          </Button>
          {canExport ? (
            <Button asChild>
              {/* Téléchargement : une route d'API (pas une page) ; mêmes filtres que la liste. */}
              <a href={`/api/leads/export?${leadListQuery(filters)}`} download aria-describedby="export-hint">
                <DownloadIcon aria-hidden="true" />
                {t("leads.export")}
              </a>
            </Button>
          ) : null}
        </div>
      </header>
      {canExport ? (
        <p id="export-hint" className="text-muted-foreground -mt-4 text-xs">
          {t("leads.exportHint")}
        </p>
      ) : null}

      <Card>
        <CardContent>
          {loaded === null ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{t("errors.generic")}</AlertDescription>
            </Alert>
          ) : (
            <LeadFilters
              locale={locale}
              filters={filters}
              projects={loaded[1]}
              stages={loaded[2]}
              sources={sources}
              assignees={loaded[3]
                .filter((member) => member.status === "active" && (member.role === "company_owner" || member.role === "company_admin" || member.role === "sales_agent"))
                .map((member) => ({ userId: member.user_id, label: t("assignee.member", { id: shortIdOf(member.user_id) }) }))}
            />
          )}
        </CardContent>
      </Card>

      {loaded === null ? null : (
        <Card className="min-w-0">
          <CardContent className="grid min-w-0 gap-4">
            <p className="text-muted-foreground text-sm" role="status">
              {t("leads.count", { count: format.number(loaded[0].total) })}
            </p>
            <div className="overflow-x-auto">
              <LeadTable locale={locale} rows={loaded[0].rows} userId={ctx.userId} filtered={filtered} />
            </div>
            {loaded[0].pageCount > 1 ? (
              <nav aria-label={t("pagination.label")} className="flex items-center justify-between gap-3">
                <Button asChild variant="outline" size="sm" className={page <= 1 ? "pointer-events-none opacity-50" : undefined}>
                  <Link
                    href={`/leads?${leadListQuery(filters, page - 1)}`}
                    aria-disabled={page <= 1}
                    tabIndex={page <= 1 ? -1 : undefined}
                    rel="prev"
                  >
                    <ChevronLeftIcon aria-hidden="true" className="rtl:rotate-180" />
                    {t("pagination.previous")}
                  </Link>
                </Button>
                <span className="text-muted-foreground text-sm">
                  {t("pagination.status", { page: format.number(page), pageCount: format.number(loaded[0].pageCount) })}
                </span>
                <Button asChild variant="outline" size="sm" className={page >= loaded[0].pageCount ? "pointer-events-none opacity-50" : undefined}>
                  <Link
                    href={`/leads?${leadListQuery(filters, page + 1)}`}
                    aria-disabled={page >= loaded[0].pageCount}
                    tabIndex={page >= loaded[0].pageCount ? -1 : undefined}
                    rel="next"
                  >
                    {t("pagination.next")}
                    <ChevronRightIcon aria-hidden="true" className="rtl:rotate-180" />
                  </Link>
                </Button>
              </nav>
            ) : null}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
