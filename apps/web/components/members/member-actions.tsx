"use client";

import type { TenantRole } from "@fusion-leap/domain";
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import { changeMemberRoleAction, removeMemberAction, transferOwnershipAction } from "../../lib/members/actions";
import type { MembersActionState } from "../../lib/members/types";
import { ActionFeedback } from "./action-feedback";
import styles from "./members.module.css";
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

type Confirming = "remove" | "transfer" | null;

/**
 * Actions d'une ligne de membre. Les booléens `can*` ne servent qu'à l'affichage : chaque action
 * serveur revérifie le contexte, `can()`/`canManageMember()` puis la RLS. La confirmation se fait
 * dans la page (aucun window.confirm).
 */
export function MemberActions({ organizationId, memberId, shortId, role, roleOptions, canChangeRole, canRemove, canTransfer }: Props) {
  const t = useTranslations("Members");
  const to = useTranslations("Org");
  const uiLocale = useLocale();
  const uid = useId();
  const subject = t("list.subject", { id: shortId });

  const [roleState, roleAction, rolePending] = useActionState(changeMemberRoleAction, initialState);
  const announce = useAnnounce();
  const [removeState, removeAction, removePending] = useActionState(async (prev: MembersActionState, formData: FormData) => {
    const result = await removeMemberAction(prev, formData);
    // La ligne disparaît après le retrait : le succès est annoncé au niveau de la page.
    if (result.status === "success") announce("removed", "members-title");
    return result;
  }, initialState);
  const [transferState, transferAction, transferPending] = useActionState(transferOwnershipAction, initialState);
  const [confirming, setConfirming] = useState<Confirming>(null);
  // Clé d'idempotence du transfert : créée à l'ouverture de la confirmation (événement client, donc sans écart d'hydratation).
  const [transferKey, setTransferKey] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Le focus passe au bouton « Annuler » à l'ouverture de la confirmation (action sûre par défaut).
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  const roleId = `${uid}-role`;
  const roleInvalid = roleState.status === "error";
  const common = (
    <>
      <input type="hidden" name="uiLocale" value={uiLocale} />
      <input type="hidden" name="organization_id" value={organizationId} />
      <input type="hidden" name="member_id" value={memberId} />
    </>
  );

  return (
    <div className={styles.rowActions}>
      {canChangeRole ? (
        <form action={roleAction} className={styles.inlineForm}>
          {common}
          <label className={styles.srOnly} htmlFor={roleId}>
            {t("actions.roleLabel", { subject })}
          </label>
          <select id={roleId} name="role" className={styles.select} defaultValue={role} aria-invalid={roleInvalid}>
            {roleOptions.map((option) => (
              <option key={option} value={option}>
                {to(`roles.${option}`)}
              </option>
            ))}
          </select>
          <button className="btn btn-secondary" type="submit" disabled={rolePending} aria-label={t("actions.saveRoleLabel", { subject })}>
            {t("actions.saveRole")}
          </button>
        </form>
      ) : null}

      {canTransfer ? (
        <button
          className="btn btn-secondary"
          type="button"
          aria-label={t("actions.transferLabel", { subject })}
          aria-expanded={confirming === "transfer"}
          onClick={() => {
            setTransferKey(crypto.randomUUID());
            setConfirming("transfer");
          }}
        >
          {t("actions.transfer")}
        </button>
      ) : null}

      {canRemove ? (
        <button
          className="btn btn-secondary"
          type="button"
          aria-label={t("actions.removeLabel", { subject })}
          aria-expanded={confirming === "remove"}
          onClick={() => setConfirming("remove")}
        >
          {t("actions.remove")}
        </button>
      ) : null}

      {confirming ? (
        <form
          className={`${styles.confirm} ${styles.fullWidth}`}
          action={(formData) => {
            setConfirming(null);
            (confirming === "remove" ? removeAction : transferAction)(formData);
          }}
        >
          {common}
          {confirming === "transfer" ? <input type="hidden" name="idempotency_key" value={transferKey} /> : null}
          <p>{confirming === "remove" ? t("actions.removeConfirm", { subject }) : t("actions.transferConfirm", { subject })}</p>
          <div className="actions">
            <button className={`btn ${styles.btnDanger}`} type="submit" disabled={removePending || transferPending}>
              {t("actions.confirm")}
            </button>
            <button ref={cancelRef} className="btn btn-secondary" type="button" onClick={() => setConfirming(null)}>
              {t("actions.cancel")}
            </button>
          </div>
        </form>
      ) : null}

      <div className={styles.fullWidth}>
        <ActionFeedback state={roleState} successKey="roleChanged" />
        <ActionFeedback state={removeState} />
        <ActionFeedback state={transferState} successKey="transferred" />
      </div>
    </div>
  );
}
