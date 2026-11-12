import { localeSchema } from "@fusion-leap/domain";
import { can } from "@fusion-leap/permissions";
import { PlusIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ProjectList } from "../../../../components/projects/project-list";
import { Link } from "../../../../i18n/navigation";
import { requireLocale } from "../../../../i18n/require-locale";
import { requireClaims } from "../../../../lib/auth/require-claims";
import { listProjects } from "../../../../lib/projects/queries";
import { createClient } from "../../../../lib/supabase/server";
import { requireTenantContext } from "../../../../lib/tenant/context";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ status?: string | string[] }>;
};

/** Projets de l'entreprise active. Lecture : tous les rôles ; création : owner et admin (matrice ADR 014). */
export default async function ProjectsPage({ params, searchParams }: Props) {
  const locale = localeSchema.parse(await requireLocale(params));
  const t = await getTranslations({ locale, namespace: "Projects" });
  await requireClaims(locale);
  const ctx = await requireTenantContext(locale);

  const { status } = await searchParams;
  const archivedView = status === "archived";
  const canCreate = can(ctx.role, "create", "projects");

  let projects: Awaited<ReturnType<typeof listProjects>> | null = null;
  try {
    projects = await listProjects(await createClient(), ctx.organizationId, { status: archivedView ? "archived" : "active" });
  } catch {
    projects = null;
  }

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="grid gap-1">
          <h1 id="projects-title" className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="text-muted-foreground max-w-prose text-sm">{t("description")}</p>
          {canCreate ? null : <p className="text-muted-foreground text-xs">{t("list.readOnlyHint")}</p>}
        </div>
        {canCreate ? (
          <Button asChild>
            <Link href="/projects/new">
              <PlusIcon aria-hidden="true" />
              {t("list.new")}
            </Link>
          </Button>
        ) : null}
      </header>

      <nav aria-label={t("list.filterLabel")} className="flex gap-2">
        <Button asChild variant={archivedView ? "outline" : "secondary"} size="sm">
          <Link href="/projects" aria-current={archivedView ? undefined : "page"}>
            {t("list.active")}
          </Link>
        </Button>
        <Button asChild variant={archivedView ? "secondary" : "outline"} size="sm">
          <Link href="/projects?status=archived" aria-current={archivedView ? "page" : undefined}>
            {t("list.archived")}
          </Link>
        </Button>
      </nav>

      <Card>
        <CardContent>
          {projects === null ? (
            <Alert variant="destructive" role="alert">
              {t("errors.generic")}
            </Alert>
          ) : (
            <ProjectList locale={locale} projects={projects} archivedView={archivedView} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
