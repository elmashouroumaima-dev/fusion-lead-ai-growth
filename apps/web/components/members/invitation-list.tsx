import type { AuthLocale, InvitationRow, TenantRole } from "@fusion-leap/domain";
import { can } from "@fusion-leap/permissions";
import { getFormatter, getTranslations } from "next-intl/server";
import styles from "./members.module.css";
import { RevokeInvitationForm } from "./revoke-invitation-form";

type Props = {
  locale: AuthLocale;
  organizationId: string;
  currentRole: TenantRole;
  invitations: readonly InvitationRow[];
  /** Instant de rendu : une invitation expirée mais non révoquée reste listée, signalée « expirée ». */
  now: Date;
};

export async function InvitationList({ locale, organizationId, currentRole, invitations, now }: Props) {
  const t = await getTranslations({ locale, namespace: "Members" });
  const to = await getTranslations({ locale, namespace: "Org" });
  const format = await getFormatter({ locale });

  if (invitations.length === 0) return <p className="lead">{t("invitations.empty")}</p>;

  return (
    <ul className={styles.list}>
      {invitations.map((invitation) => {
        const expiresAt = new Date(invitation.expires_at);
        const expired = !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= now.getTime();
        // Un admin ne révoque pas une invitation « owner » (le serveur et la base le refusent aussi).
        const canRevoke = can(currentRole, "invite", "members", { assignedRole: invitation.role });

        return (
          <li key={invitation.id} className={styles.item}>
            <div className={styles.itemHead}>
              <bdi className={styles.subject} dir="ltr">
                {invitation.email_normalized}
              </bdi>
              <span className={styles.badge}>{to(`roles.${invitation.role}`)}</span>
            </div>
            <div className={styles.itemHead}>
              <span className={styles.meta}>
                {Number.isNaN(expiresAt.getTime()) ? null : t("invitations.expires", { date: format.dateTime(expiresAt, { dateStyle: "medium" }) })}
              </span>
              {expired ? <span className={`${styles.badge} ${styles.badgeWarn}`}>{t("invitations.expired")}</span> : null}
            </div>
            {canRevoke ? (
              <RevokeInvitationForm organizationId={organizationId} invitationId={invitation.id} subject={invitation.email_normalized} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
