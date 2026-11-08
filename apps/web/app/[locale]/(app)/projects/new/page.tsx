import { localeSchema } from "@fusion-leap/domain";
import { can } from "@fusion-leap/permissions";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { ProjectForm } from "../../../../../components/projects/project-form";
import { Link } from "../../../../../i18n/navigation";
import { requireLocale } from "../../../../../i18n/require-locale";
import { requireClaims } from "../../../../../lib/auth/require-claims";
import { requireTenantContext } from "../../../../../lib/tenant/context";

export const dynamic = "force-dynamic";

/** Création d'un projet : owner et admin (matrice ADR 014) ; les autres rôles retournent à la liste. */
export default async function NewProjectPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = localeSchema.parse(await requireLocale(params));
  const t = await getTranslations({ locale, namespace: "Projects" });
  await requireClaims(locale);
  const ctx = await requireTenantContext(locale);
  if (!can(ctx.role, "create", "projects")) redirect(`/${locale}/projects`);

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-6">
      <header className="grid gap-1">
        <Link href="/projects" className="text-primary-text w-fit text-sm underline underline-offset-2">
          {t("new.back")}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{t("new.title")}</h1>
        <p className="text-muted-foreground max-w-prose text-sm">{t("new.description")}</p>
      </header>
      <Card>
        <CardContent>
          <ProjectForm organizationId={ctx.organizationId} idempotencyKey={crypto.randomUUID()} />
        </CardContent>
      </Card>
    </div>
  );
}
