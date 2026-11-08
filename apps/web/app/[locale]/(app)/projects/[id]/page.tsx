import { localeSchema, uuidSchema } from "@fusion-leap/domain";
import { can } from "@fusion-leap/permissions";
import { getFormatter, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ProductDialog } from "../../../../../components/projects/product-dialog";
import { ProductList } from "../../../../../components/projects/product-list";
import { ProjectForm } from "../../../../../components/projects/project-form";
import { ProjectStatusButton } from "../../../../../components/projects/project-status-button";
import { Link } from "../../../../../i18n/navigation";
import { requireLocale } from "../../../../../i18n/require-locale";
import { requireClaims } from "../../../../../lib/auth/require-claims";
import { getProject, listProducts } from "../../../../../lib/projects/queries";
import { createClient } from "../../../../../lib/supabase/server";
import { requireTenantContext } from "../../../../../lib/tenant/context";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ created?: string | string[] }>;
};

const sectionTitleClass = "text-lg leading-none font-semibold outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px] rounded-sm";

/**
 * Page d'un projet : réglages (modifiables par owner et admin tant que le projet est actif), produits, archivage. Un projet
 * d'une autre entreprise, inexistant ou illisible donne la même page « introuvable » (aucune différence observable).
 */
export default async function ProjectPage({ params, searchParams }: Props) {
  const { id } = await params;
  const locale = localeSchema.parse(await requireLocale(params));
  const t = await getTranslations({ locale, namespace: "Projects" });
  const format = await getFormatter({ locale });
  await requireClaims(locale);
  const ctx = await requireTenantContext(locale);

  const parsedId = uuidSchema.safeParse(id);
  if (!parsedId.success) notFound();

  const supabase = await createClient();
  let project;
  let products;
  try {
    project = await getProject(supabase, ctx.organizationId, parsedId.data);
    products = project ? await listProducts(supabase, ctx.organizationId, project.id) : [];
  } catch {
    return (
      <div className="mx-auto grid w-full max-w-5xl gap-6">
        <Alert variant="destructive" role="alert">
          {t("errors.generic")}
        </Alert>
      </div>
    );
  }
  if (!project) notFound();

  const { created } = await searchParams;
  const archived = project.status === "archived";
  const canUpdate = can(ctx.role, "update", "projects");
  const canArchive = can(ctx.role, "archive", "projects");
  const editable = canUpdate && !archived;

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="grid gap-1">
          <Link href="/projects" className="text-primary-text w-fit text-sm underline underline-offset-2">
            {t("detail.back")}
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">
            <bdi>{project.name}</bdi>
          </h1>
          <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
            <span>{t(`types.${project.type}`)}</span>
            <Badge variant={archived ? "outline" : "success"}>{t(`status.${project.status}`)}</Badge>
            <span>{t("detail.createdOn", { date: format.dateTime(new Date(project.created_at), { dateStyle: "medium" }) })}</span>
          </div>
        </div>
        {canArchive ? <ProjectStatusButton organizationId={ctx.organizationId} projectId={project.id} status={project.status} /> : null}
      </header>

      {created === "1" ? (
        <Alert role="status">
          <p className="text-sm">{t("success.created")}</p>
        </Alert>
      ) : null}
      {archived ? (
        <Alert role="status">
          <p className="text-sm">{t("detail.archivedNotice")}</p>
        </Alert>
      ) : null}

      <Card role="region" aria-labelledby="settings-title">
        <CardHeader>
          <h2 id="settings-title" tabIndex={-1} className={sectionTitleClass}>
            {t("detail.settings")}
          </h2>
        </CardHeader>
        <CardContent>
          <ProjectForm
            organizationId={ctx.organizationId}
            project={{ id: project.id, type: project.type, name: project.name, settings: project.settings }}
            readOnly={!editable}
          />
        </CardContent>
      </Card>

      <Card role="region" aria-labelledby="products-title">
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <h2 id="products-title" tabIndex={-1} className={sectionTitleClass}>
            {t("detail.products")}
          </h2>
          {editable ? <ProductDialog organizationId={ctx.organizationId} projectId={project.id} idempotencyKey={crypto.randomUUID()} /> : null}
        </CardHeader>
        <CardContent>
          <ProductList locale={locale} organizationId={ctx.organizationId} projectId={project.id} products={products} canEdit={editable} />
        </CardContent>
      </Card>
    </div>
  );
}
