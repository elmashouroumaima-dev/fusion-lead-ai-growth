import { localeSchema, type InvitationRow, type MemberRow } from "@fusion-leap/domain";
import { assignableRoles, can } from "@fusion-leap/permissions";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { InvitationList } from "../../../../components/members/invitation-list";
import { InviteForm } from "../../../../components/members/invite-form";
import { MemberList } from "../../../../components/members/member-list";
import styles from "../../../../components/members/members.module.css";
import { MembersPageFeedback } from "../../../../components/members/page-feedback";
import { requireLocale } from "../../../../i18n/require-locale";
import { requireClaims } from "../../../../lib/auth/require-claims";
import { listOrganizationMembers, listPendingInvitations } from "../../../../lib/members/queries";
import { requireTenantContext } from "../../../../lib/tenant/context";

export const dynamic = "force-dynamic";

type LoadResult = { ok: true; members: MemberRow[]; invitations: InvitationRow[] } | { ok: false };

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

  return (
    <div className={styles.page}>
      <section className="card">
        <h1>{t("title")}</h1>
        <p className="lead">{t("description")}</p>
      </section>

      {loaded.ok ? (
        <MembersPageFeedback>
          <section className={`card ${styles.section}`} aria-labelledby="invite-title">
            <h2 id="invite-title">{t("invite.title")}</h2>
            <p className="lead">{t("invite.description")}</p>
            <InviteForm organizationId={ctx.organizationId} idempotencyKey={crypto.randomUUID()} roleOptions={assignableRoles(ctx.role)} />
          </section>

          <section className={`card ${styles.section}`} aria-labelledby="pending-title">
            <h2 id="pending-title" tabIndex={-1}>{t("invitations.title")}</h2>
            <InvitationList
              locale={locale}
              organizationId={ctx.organizationId}
              currentRole={ctx.role}
              invitations={loaded.invitations}
              now={new Date()}
            />
          </section>

          <section className={`card ${styles.section}`} aria-labelledby="members-title">
            <h2 id="members-title" tabIndex={-1}>{t("list.title")}</h2>
            <MemberList
              locale={locale}
              organizationId={ctx.organizationId}
              currentUserId={ctx.userId}
              currentRole={ctx.role}
              members={loaded.members}
            />
          </section>
        </MembersPageFeedback>
      ) : (
        <p role="alert" className="notice notice-error">
          {t("errors.loadFailed")}
        </p>
      )}
    </div>
  );
}
