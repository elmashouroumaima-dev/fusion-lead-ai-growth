import { localeSchema, uuidSchema } from "@fusion-leap/domain";
import { can } from "@fusion-leap/permissions";
import { KanbanSquareIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { DealBoard } from "../../../../components/crm/deal-board";
import { requireLocale } from "../../../../i18n/require-locale";
import { requireClaims } from "../../../../lib/auth/require-claims";
import { BOARD_MAX_DEALS, listBoardDeals } from "../../../../lib/crm/service";
import { listPipelines, listStages } from "../../../../lib/leads/queries";
import { listProjects } from "../../../../lib/projects/queries";
import { createClient } from "../../../../lib/supabase/server";
import { requireTenantContext } from "../../../../lib/tenant/context";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ project?: string | string[] }>;
};

/**
 * Tableau des deals de l'entreprise active, par étape du pipeline par défaut (l'étape système « non assigné » est réservée aux leads).
 * Lecture : owner, admin, marketing (tous les deals), commercial (les siens), analyste redirigé (PII). Déplacement : owner, admin et
 * commercial (matrice ADR 014 ligne 14) ; la base revérifie rôle et propriété.
 */
export default async function DealsPage({ params, searchParams }: Props) {
  const locale = localeSchema.parse(await requireLocale(params));
  const t = await getTranslations({ locale, namespace: "Crm" });
  await requireClaims(locale);
  const ctx = await requireTenantContext(locale);
  if (!can(ctx.role, "read", "deals", { isOwnRecord: true })) redirect(`/${locale}/dashboard`);

  const rawProject = (await searchParams).project;
  const parsedProject = uuidSchema.safeParse(Array.isArray(rawProject) ? rawProject[0] : rawProject);
  const projectId = parsedProject.success ? parsedProject.data : null;
  const canMove = can(ctx.role, "change_stage", "deals", { isOwnRecord: true });

  const supabase = await createClient();
  const loaded = await Promise.all([
    listPipelines(supabase, ctx.organizationId).then((pipelines) => {
      const pipeline = pipelines.find((item) => item.is_default) ?? pipelines[0];
      return pipeline ? listStages(supabase, ctx.organizationId, pipeline.id) : [];
    }),
    listBoardDeals(supabase, ctx.organizationId, { projectId }),
    listProjects(supabase, ctx.organizationId),
  ]).then(
    (value) => value,
    () => null,
  );

  const selectClass =
    "border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 flex h-9 min-w-48 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs outline-none focus-visible:ring-[3px] md:text-sm";

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-7xl gap-6">
      <header className="grid gap-1">
        <h1 id="deals-title" className="text-2xl font-semibold tracking-tight">
          {t("deals.title")}
        </h1>
        <p className="text-muted-foreground max-w-prose text-sm">{t("deals.description")}</p>
        <p className="text-muted-foreground text-xs">{canMove ? t("deals.dragHint") : t("deals.readOnlyHint")}</p>
      </header>

      {loaded === null ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t("errors.generic")}</AlertDescription>
        </Alert>
      ) : (
        <>
          <form method="get" className="flex flex-wrap items-end gap-3" aria-label={t("deals.project")}>
            <div className="grid gap-1.5">
              <Label htmlFor="deals-project">{t("deals.project")}</Label>
              <select id="deals-project" name="project" defaultValue={projectId ?? ""} className={selectClass}>
                <option value="">{t("deals.allProjects")}</option>
                {loaded[2].map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" variant="outline">
              {t("deals.filter")}
            </Button>
          </form>

          <Card className="min-w-0">
            <CardContent className="min-w-0">
              {loaded[0].filter((stage) => stage.kind !== "unassigned").length === 0 || (loaded[1].length === 0 && !projectId) ? (
                <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center text-sm">
                  <KanbanSquareIcon className="size-6" aria-hidden="true" />
                  <p>{t("deals.empty")}</p>
                </div>
              ) : (
                <DealBoard
                  key={`${projectId ?? "all"}:${loaded[1].length}`}
                  stages={loaded[0].filter((stage) => stage.kind !== "unassigned").map((stage) => ({ id: stage.id, name: stage.name, kind: stage.kind }))}
                  deals={loaded[1]}
                  canMove={canMove}
                />
              )}
              {loaded[1].length >= BOARD_MAX_DEALS ? <p className="text-muted-foreground mt-3 text-xs">{t("deals.limitHint", { count: BOARD_MAX_DEALS })}</p> : null}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
