import type { AuthLocale, InvitationRow, TenantRole } from "@fusion-leap/domain";
import { can } from "@fusion-leap/permissions";
import { MailIcon } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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

  if (invitations.length === 0) {
    return (
      <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center text-sm">
        <MailIcon className="size-6" aria-hidden="true" />
        <p>{t("invitations.empty")}</p>
      </div>
    );
  }

  return (
    <Table aria-labelledby="pending-title" className="min-w-[32rem]">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t("table.email")}</TableHead>
          <TableHead scope="col">{t("table.role")}</TableHead>
          <TableHead scope="col">{t("table.expires")}</TableHead>
          <TableHead scope="col" className="text-end">
            {t("table.actions")}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invitations.map((invitation) => {
          const expiresAt = new Date(invitation.expires_at);
          const validDate = !Number.isNaN(expiresAt.getTime());
          const expired = validDate && expiresAt.getTime() <= now.getTime();
          // Un admin ne révoque pas une invitation « owner » (le serveur et la base le refusent aussi).
          const canRevoke = can(currentRole, "invite", "members", { assignedRole: invitation.role });

          return (
            <TableRow key={invitation.id}>
              <TableCell className="font-medium">
                <bdi dir="ltr" className="break-all">
                  {invitation.email_normalized}
                </bdi>
              </TableCell>
              <TableCell>
                <Badge variant="outline">{to(`roles.${invitation.role}`)}</Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">
                <span className="flex flex-wrap items-center gap-2">
                  {validDate ? format.dateTime(expiresAt, { dateStyle: "medium" }) : null}
                  {expired ? <Badge variant="warning">{t("invitations.expired")}</Badge> : null}
                </span>
              </TableCell>
              <TableCell className="text-end">
                {canRevoke ? (
                  <RevokeInvitationForm organizationId={organizationId} invitationId={invitation.id} subject={invitation.email_normalized} />
                ) : null}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
