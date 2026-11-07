"use client";

import type { TenantRole } from "@fusion-leap/domain";
import { CrownIcon, MoreHorizontalIcon, ShieldIcon, UserMinusIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { changeMemberRoleAction, removeMemberAction, transferOwnershipAction } from "../../lib/members/actions";
import type { MembersActionState } from "../../lib/members/types";
import { ActionFeedback } from "./action-feedback";
import { useAnnounce } from "./page-feedback";

type Props = {
  organizationId: string;
  memberId: string;
  /** Identifiant court opaque (les e-mails des membres ne sont pas lisibles sans service_role). */
  shortId: string;
  role: TenantRole;
  /** Rôles proposés dans le sélecteur (assignableRoles de l'utilisateur courant). */
  roleOptions: readonly TenantRole[];
  canChangeRole: boolean;
  canRemove: boolean;
  canTransfer: boolean;
};

const initialState: MembersActionState = { status: "idle" };

type OpenDialog = "role" | "remove" | "transfer" | null;
type Outcome = "roleChanged" | "transferred";

/**
 * Actions d'une ligne de membre : un menu (modifier le rôle, transférer la propriété, retirer) dont
 * chaque choix ouvre une fenêtre de confirmation dans la page (aucun window.confirm). Les booléens
 * `can*` ne servent qu'à l'affichage : chaque action serveur revérifie le contexte, `can()` /
 * `canManageMember()` puis la RLS.
 */
export function MemberActions({ organizationId, memberId, shortId, role, roleOptions, canChangeRole, canRemove, canTransfer }: Props) {
  const t = useTranslations("Members");
  const to = useTranslations("Org");
  const uiLocale = useLocale();
  const uid = useId();
  const subject = t("list.subject", { id: shortId });

  const announce = useAnnounce();
  // Le résultat est annoncé par la région live de la ligne (ActionFeedback) ET affiché en notification :
  // verte pour le succès du rôle / transfert, rouge pour toute erreur.
  const notify = (result: MembersActionState, success?: Outcome) => {
    if (result.status === "success" && success) toast.success(t(`success.${success}`));
    if (result.status === "error") toast.error(t(`errors.${result.code ?? "generic"}`));
  };
  const [roleState, roleAction, rolePending] = useActionState(async (prev: MembersActionState, formData: FormData) => {
    const result = await changeMemberRoleAction(prev, formData);
    notify(result, "roleChanged");
    return result;
  }, initialState);
  const [removeState, removeAction, removePending] = useActionState(async (prev: MembersActionState, formData: FormData) => {
    const result = await removeMemberAction(prev, formData);
    notify(result);
    // La ligne disparaît après le retrait : le succès est annoncé au niveau de la page.
    if (result.status === "success") announce("removed", "members-title");
    return result;
  }, initialState);
  const [transferState, transferAction, transferPending] = useActionState(async (prev: MembersActionState, formData: FormData) => {
    const result = await transferOwnershipAction(prev, formData);
    notify(result, "transferred");
    return result;
  }, initialState);
  const [dialog, setDialog] = useState<OpenDialog>(null);
  // Clé d'idempotence du transfert : créée à l'ouverture de la confirmation (événement client, donc sans écart d'hydratation).
  const [transferKey, setTransferKey] = useState("");

  const roleId = `${uid}-role`;
  const busy = rolePending || removePending || transferPending;
  const common = (
    <>
      <input type="hidden" name="uiLocale" value={uiLocale} />
      <input type="hidden" name="organization_id" value={organizationId} />
      <input type="hidden" name="member_id" value={memberId} />
    </>
  );

  return (
    <div className="flex flex-col items-end gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" disabled={busy} aria-label={t("actions.menu", { subject })}>
            <MoreHorizontalIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canChangeRole ? (
            <DropdownMenuItem onSelect={() => setDialog("role")}>
              <ShieldIcon aria-hidden="true" />
              {t("actions.changeRole")}
            </DropdownMenuItem>
          ) : null}
          {canTransfer ? (
            <DropdownMenuItem
              aria-label={t("actions.transferLabel", { subject })}
              onSelect={() => {
                setTransferKey(crypto.randomUUID());
                setDialog("transfer");
              }}
            >
              <CrownIcon aria-hidden="true" />
              {t("actions.transfer")}
            </DropdownMenuItem>
          ) : null}
          {canRemove ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" aria-label={t("actions.removeLabel", { subject })} onSelect={() => setDialog("remove")}>
                <UserMinusIcon aria-hidden="true" />
                {t("actions.remove")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialog === "role"} onOpenChange={(next) => setDialog(next ? "role" : null)}>
        <DialogContent closeLabel={t("dialog.close")}>
          <DialogHeader>
            <DialogTitle>{t("actions.changeRoleTitle")}</DialogTitle>
            <DialogDescription>{t("actions.changeRoleDescription", { subject })}</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            action={(formData) => {
              setDialog(null);
              roleAction(formData);
            }}
          >
            {common}
            <div className="grid gap-2">
              <Label htmlFor={roleId}>{t("actions.roleLabel", { subject })}</Label>
              <Select name="role" defaultValue={role} required>
                <SelectTrigger id={roleId} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roleOptions.map((option) => (
                    <SelectItem key={option} value={option}>
                      {to(`roles.${option}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialog(null)}>
                {t("actions.cancel")}
              </Button>
              <Button type="submit" disabled={rolePending} aria-label={t("actions.saveRoleLabel", { subject })}>
                {t("actions.saveRole")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "transfer"} onOpenChange={(next) => setDialog(next ? "transfer" : null)}>
        <DialogContent closeLabel={t("dialog.close")}>
          <DialogHeader>
            <DialogTitle>{t("actions.transferTitle")}</DialogTitle>
            <DialogDescription>{t("actions.transferConfirm", { subject })}</DialogDescription>
          </DialogHeader>
          <form
            action={(formData) => {
              setDialog(null);
              transferAction(formData);
            }}
          >
            {common}
            <input type="hidden" name="idempotency_key" value={transferKey} />
            <DialogFooter>
              <Button type="button" variant="outline" autoFocus onClick={() => setDialog(null)}>
                {t("actions.cancel")}
              </Button>
              <Button type="submit" disabled={transferPending}>
                {t("actions.confirm")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "remove"} onOpenChange={(next) => setDialog(next ? "remove" : null)}>
        <DialogContent closeLabel={t("dialog.close")}>
          <DialogHeader>
            <DialogTitle>{t("actions.removeTitle")}</DialogTitle>
            <DialogDescription>{t("actions.removeConfirm", { subject })}</DialogDescription>
          </DialogHeader>
          <form
            action={(formData) => {
              setDialog(null);
              removeAction(formData);
            }}
          >
            {common}
            <DialogFooter>
              <Button type="button" variant="outline" autoFocus onClick={() => setDialog(null)}>
                {t("actions.cancel")}
              </Button>
              <Button type="submit" variant="destructive" disabled={removePending}>
                {t("actions.confirm")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <div className="text-end">
        <ActionFeedback state={roleState} successKey="roleChanged" />
        <ActionFeedback state={removeState} />
        <ActionFeedback state={transferState} successKey="transferred" />
      </div>
    </div>
  );
}
