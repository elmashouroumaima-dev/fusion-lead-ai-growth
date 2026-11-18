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

  const rows = members.map((member) => {
    const isSelf = member.user_id === currentUserId;
    const manageable = !isSelf && member.status !== "removed" && canManageMember(currentRole, member.role);
    const canTransfer = !isSelf && member.status === "active" && member.role !== "company_owner" && can(currentRole, "transfer", "ownership");
    const shortId = shortIdOf(member.user_id);
    const joined = new Date(member.created_at);
    const joinedText = Number.isNaN(joined.getTime()) ? null : format.dateTime(joined, { dateStyle: "medium" });
    const actions =
      manageable || canTransfer ? (
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
      ) : null;
    const subject = (
      <>
        <bdi>{t("list.subject", { id: shortId })}</bdi> {isSelf ? <span className="text-muted-foreground">{t("list.you")}</span> : null}
      </>
    );
    return { member, subject, joinedText, actions };
  });

  return (
    <>
      {/* Petits écrans : une carte par membre (motif de la liste des projets) ; le tableau ne tient pas. */}
      <ul aria-labelledby="members-title" className="grid gap-4 lg:hidden">
        {rows.map(({ member, subject, joinedText, actions }) => (
          <li key={member.id} className="bg-card text-card-foreground grid min-w-0 gap-4 rounded-xl border p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 font-medium break-words">{subject}</p>
              {actions}
            </div>
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t("table.role")}</dt>
              <dd>
                <Badge variant={roleVariant(member.role)}>{to(`roles.${member.role}`)}</Badge>
              </dd>
              <dt className="text-muted-foreground">{t("table.status")}</dt>
              <dd>
                <Badge variant={statusVariant[member.status]}>{t(`status.${member.status}`)}</Badge>
              </dd>
              {joinedText ? (
                <>
                  <dt className="text-muted-foreground">{t("table.joined")}</dt>
                  <dd className="text-muted-foreground">{joinedText}</dd>
                </>
              ) : null}
            </dl>
          </li>
        ))}
      </ul>
      <div className="hidden lg:block">
        <Table aria-labelledby="members-title">
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
            {rows.map(({ member, subject, joinedText, actions }) => (
              <TableRow key={member.id}>
                <TableCell className="font-medium">{subject}</TableCell>
                <TableCell>
                  <Badge variant={roleVariant(member.role)}>{to(`roles.${member.role}`)}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant[member.status]}>{t(`status.${member.status}`)}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">{joinedText}</TableCell>
                <TableCell className="text-end">{actions}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
