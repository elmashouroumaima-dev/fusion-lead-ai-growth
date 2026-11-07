import { localeSchema, type InvitationRow, type MemberRow } from "@fusion-leap/domain";
import { assignableRoles, can } from "@fusion-leap/permissions";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { Alert } from "@/components/ui/alert";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { InvitationList } from "../../../../components/members/invitation-list";
import { InviteForm } from "../../../../components/members/invite-form";
import { MemberList } from "../../../../components/members/member-list";
import { MembersPageFeedback } from "../../../../components/members/page-feedback";
import { requireLocale } from "../../../../i18n/require-locale";
import { requireClaims } from "../../../../lib/auth/require-claims";
import { listOrganizationMembers, listPendingInvitations } from "../../../../lib/members/queries";
import { requireTenantContext } from "../../../../lib/tenant/context";

export const dynamic = "force-dynamic";

type LoadResult = { ok: true; members: MemberRow[]; invitations: InvitationRow[] } | { ok: false };

const sectionTitleClass = "text-lg leading-none font-semibold outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px] rounded-sm";

function PageHeader({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-muted-foreground max-w-prose text-sm">{description}</p>
      </div>
      {children}
    </header>
  );
}

export default async function MembersPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = localeSchema.parse(await requireLocale(params));
  const t = await getTranslations({ locale, namespace: "Members" });
  await requireClaims(locale);
  // Contexte revérifié en base à chaque requête ; redirige vers onboarding / sélection si besoin.
  const ctx = await requireTenantContext(locale);

  // Owner / admin seulement (ADR 014 : « Membres : lister ») ; les autres rôles retournent au tableau de bord.
  if (!can(ctx.role, "list", "members")) redirect(`/${locale}/dashboard`);

  let loaded: LoadResult;
  try {
    const [members, invitations] = await Promise.all([listOrganizationMembers(ctx), listPendingInvitations(ctx)]);
    loaded = { ok: true, members, invitations };
  } catch {
    loaded = { ok: false };
  }

  if (!loaded.ok) {
    return (
      <div className="mx-auto grid w-full max-w-5xl gap-6">
        <PageHeader title={t("title")} description={t("description")} />
        <Alert variant="destructive" role="alert">
          {t("errors.loadFailed")}
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6">
      <MembersPageFeedback>
        <PageHeader title={t("title")} description={t("description")}>
          <InviteForm organizationId={ctx.organizationId} idempotencyKey={crypto.randomUUID()} roleOptions={assignableRoles(ctx.role)} />
        </PageHeader>

        <Card role="region" aria-labelledby="pending-title">
          <CardHeader>
            <h2 id="pending-title" tabIndex={-1} className={sectionTitleClass}>
              {t("invitations.title")}
            </h2>
          </CardHeader>
          <CardContent>
            <InvitationList
              locale={locale}
              organizationId={ctx.organizationId}
              currentRole={ctx.role}
              invitations={loaded.invitations}
              now={new Date()}
            />
          </CardContent>
        </Card>

        <Card role="region" aria-labelledby="members-title">
          <CardHeader>
            <h2 id="members-title" tabIndex={-1} className={sectionTitleClass}>
              {t("list.title")}
            </h2>
          </CardHeader>
          <CardContent>
            <MemberList
              locale={locale}
              organizationId={ctx.organizationId}
              currentUserId={ctx.userId}
              currentRole={ctx.role}
              members={loaded.members}
            />
          </CardContent>
        </Card>
      </MembersPageFeedback>
    </div>
  );
}
