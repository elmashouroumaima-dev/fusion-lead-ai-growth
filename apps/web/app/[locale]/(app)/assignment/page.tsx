import { localeSchema } from "@fusion-leap/domain";
import { can } from "@fusion-leap/permissions";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { RulesManager, type MemberOption, type RuleView } from "../../../../components/assignment/rules-manager";
import { requireLocale } from "../../../../i18n/require-locale";
import { listAssignmentRules } from "../../../../lib/assignment/service";
import { requireClaims } from "../../../../lib/auth/require-claims";
import { listOrganizationMembers } from "../../../../lib/members/queries";
import { listProjects } from "../../../../lib/projects/queries";
import { createClient } from "../../../../lib/supabase/server";
import { requireTenantContext } from "../../../../lib/tenant/context";

export const dynamic = "force-dynamic";

/** Identifiant court opaque : les e-mails des membres ne sont pas lisibles sans service_role. */
const shortIdOf = (userId: string): string => userId.replace(/-/g, "").slice(-6).toUpperCase();
/** Rôles qui peuvent recevoir un lead (la base le revérifie à chaque assignation). */
const ASSIGNABLE = new Set(["company_owner", "company_admin", "sales_agent"]);

/**
 * Règles d'assignation (J39b, spec §5.3) : owner et admin seulement (les autres rôles reviennent au tableau de bord ; la base et les
 * routes revérifient). Les membres sont désignés par un identifiant court et leur rôle.
 */
export default async function AssignmentPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = localeSchema.parse(await requireLocale(params));
  const t = await getTranslations({ locale, namespace: "Assignment" });
  const roles = await getTranslations({ locale, namespace: "Org" });
  await requireClaims(locale);
  const ctx = await requireTenantContext(locale);
  if (!can(ctx.role, "manage", "assignment_rules")) redirect(`/${locale}/dashboard`);

  const supabase = await createClient();
  let data: { rules: RuleView[]; members: MemberOption[]; projects: { id: string; name: string }[] } | null = null;
  try {
    const [rules, members, projects] = await Promise.all([
      listAssignmentRules(supabase, ctx.organizationId),
      listOrganizationMembers(ctx),
      listProjects(supabase, ctx.organizationId, { status: "active" }),
    ]);
    const projectName = new Map(projects.map((project) => [project.id, project.name]));
    data = {
      rules: rules.map((rule) => ({
        id: rule.id,
        projectId: rule.project_id,
        projectName: rule.project_id ? (projectName.get(rule.project_id) ?? null) : null,
        strategy: rule.strategy,
        memberIds: rule.eligible_member_ids,
        active: rule.active,
      })),
      members: members
        .filter((member) => member.status === "active" && ASSIGNABLE.has(member.role))
        .map((member) => ({ userId: member.user_id, label: `${shortIdOf(member.user_id)} · ${roles(`roles.${member.role}`)}` })),
      projects: projects.map((project) => ({ id: project.id, name: project.name })),
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
      <Card>
        <CardHeader>
          <h2 className="text-lg font-medium">{t("title")}</h2>
        </CardHeader>
        <CardContent>
          {data === null ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{t("failed")}</AlertDescription>
            </Alert>
          ) : (
            <RulesManager rules={data.rules} members={data.members} projects={data.projects} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
