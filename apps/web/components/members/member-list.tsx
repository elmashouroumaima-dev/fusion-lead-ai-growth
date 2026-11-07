import type { AuthLocale, MemberRow, TenantRole } from "@fusion-leap/domain";
import { assignableRoles, canManageMember, can } from "@fusion-leap/permissions";
import { getFormatter, getTranslations } from "next-intl/server";
import { MemberActions } from "./member-actions";
import styles from "./members.module.css";

type Props = {
  locale: AuthLocale;
  organizationId: string;
  currentUserId: string;
  currentRole: TenantRole;
  members: readonly MemberRow[];
};

/** Identifiant court opaque : les e-mails des membres ne sont pas lisibles sans service_role. */
const shortIdOf = (userId: string): string => userId.replace(/-/g, "").slice(-6).toUpperCase();

export async function MemberList({ locale, organizationId, currentUserId, currentRole, members }: Props) {
  const t = await getTranslations({ locale, namespace: "Members" });
  const to = await getTranslations({ locale, namespace: "Org" });
  const format = await getFormatter({ locale });
  const roleOptions = assignableRoles(currentRole);

  if (members.length === 0) return <p className="lead">{t("list.empty")}</p>;

  return (
    <ul className={styles.list}>
      {members.map((member) => {
        const isSelf = member.user_id === currentUserId;
        const manageable = !isSelf && member.status !== "removed" && canManageMember(currentRole, member.role);
        const canTransfer =
          !isSelf && member.status === "active" && member.role !== "company_owner" && can(currentRole, "transfer", "ownership");
        const shortId = shortIdOf(member.user_id);
        const joined = new Date(member.created_at);

        return (
          <li key={member.id} className={styles.item}>
            <div className={styles.itemHead}>
              <span className={styles.subject}>
                <bdi>{t("list.subject", { id: shortId })}</bdi> {isSelf ? t("list.you") : null}
              </span>
              <span className={styles.badge}>{to(`roles.${member.role}`)}</span>
            </div>
            <div className={styles.itemHead}>
              <span className={styles.meta}>
                {t(`status.${member.status}`)}
                {Number.isNaN(joined.getTime()) ? null : ` · ${t("list.since", { date: format.dateTime(joined, { dateStyle: "medium" }) })}`}
              </span>
            </div>
            {manageable || canTransfer ? (
              <MemberActions
                organizationId={organizationId}
                memberId={member.id}
                shortId={shortId}
                role={member.role}
                roleOptions={roleOptions}
                canChangeRole={manageable}
                canRemove={manageable}
                canTransfer={canTransfer}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
