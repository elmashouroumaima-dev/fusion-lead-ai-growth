import type { AuthLocale, MemberRow, TenantRole } from "@fusion-leap/domain";
import { assignableRoles, canManageMember, can } from "@fusion-leap/permissions";
import { UsersIcon } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MemberActions } from "./member-actions";

type Props = {
  locale: AuthLocale;
  organizationId: string;
  currentUserId: string;
  currentRole: TenantRole;
  members: readonly MemberRow[];
};

/** Identifiant court opaque : les e-mails des membres ne sont pas lisibles sans service_role. */
const shortIdOf = (userId: string): string => userId.replace(/-/g, "").slice(-6).toUpperCase();

const statusVariant = { active: "success", invited: "secondary", suspended: "warning", removed: "outline" } as const;
const roleVariant = (role: TenantRole) => (role === "company_owner" ? "default" : role === "company_admin" ? "secondary" : "outline");

export async function MemberList({ locale, organizationId, currentUserId, currentRole, members }: Props) {
  const t = await getTranslations({ locale, namespace: "Members" });
  const to = await getTranslations({ locale, namespace: "Org" });
  const format = await getFormatter({ locale });
  const roleOptions = assignableRoles(currentRole);

  if (members.length === 0) {
    return (
      <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center text-sm">
        <UsersIcon className="size-6" aria-hidden="true" />
        <p>{t("list.empty")}</p>
      </div>
    );
  }

  return (
    <Table aria-labelledby="members-title" className="min-w-[36rem]">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t("table.member")}</TableHead>
          <TableHead scope="col">{t("table.role")}</TableHead>
          <TableHead scope="col">{t("table.status")}</TableHead>
          <TableHead scope="col">{t("table.joined")}</TableHead>
          <TableHead scope="col" className="text-end">
            {t("table.actions")}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((member) => {
          const isSelf = member.user_id === currentUserId;
          const manageable = !isSelf && member.status !== "removed" && canManageMember(currentRole, member.role);
          const canTransfer =
            !isSelf && member.status === "active" && member.role !== "company_owner" && can(currentRole, "transfer", "ownership");
          const shortId = shortIdOf(member.user_id);
          const joined = new Date(member.created_at);

          return (
            <TableRow key={member.id}>
              <TableCell className="font-medium">
                <bdi>{t("list.subject", { id: shortId })}</bdi> {isSelf ? <span className="text-muted-foreground">{t("list.you")}</span> : null}
              </TableCell>
              <TableCell>
                <Badge variant={roleVariant(member.role)}>{to(`roles.${member.role}`)}</Badge>
              </TableCell>
              <TableCell>
                <Badge variant={statusVariant[member.status]}>{t(`status.${member.status}`)}</Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {Number.isNaN(joined.getTime()) ? null : format.dateTime(joined, { dateStyle: "medium" })}
              </TableCell>
              <TableCell className="text-end">
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
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
