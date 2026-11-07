"use client";

import { INVITATION_EXPIRY_DAYS, type TenantRole } from "@fusion-leap/domain";
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { inviteMemberAction } from "../../lib/members/actions";
import { shouldRenewIdempotencyKey } from "../../lib/members/idempotency-key";
import type { MembersActionState } from "../../lib/members/types";
import styles from "./members.module.css";

type Props = {
  organizationId: string;
  /**
   * Clé d'idempotence générée côté serveur (crypto.randomUUID()) à chaque rendu de la page : un envoi
   * rejoué (double clic, nouvel essai réseau) ne crée pas de seconde invitation. Renouvelée après chaque
   * réponse définitive pour que l'invitation suivante soit une nouvelle intention.
   */
  idempotencyKey: string;
  /** Rôles attribuables par l'utilisateur courant (assignableRoles) : une commodité, la base revérifie. */
  roleOptions: readonly TenantRole[];
};

const initialState: MembersActionState = { status: "idle" };
const noopSubscribe = () => () => {};

export function InviteForm({ organizationId, idempotencyKey, roleOptions }: Props) {
  const t = useTranslations("Members");
  const tc = useTranslations("Common");
  const to = useTranslations("Org");
  const uiLocale = useLocale();
  const uid = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [key, setKey] = useState(idempotencyKey);
  const [state, formAction, pending] = useActionState(async (prev: MembersActionState, formData: FormData) => {
    const result = await inviteMemberAction(prev, formData);
    // Nouvelle clé seulement après un succès ou un conflit ; jamais pendant `idempotency_in_progress` (voir la règle).
    if (shouldRenewIdempotencyKey(result)) {
      setKey(crypto.randomUUID());
    }
    return result;
  }, initialState);

  // Après un succès, le champ e-mail est vidé : le lien affiché ne dépend pas du formulaire.
  useEffect(() => {
    if (state.status === "success") formRef.current?.reset();
  }, [state]);

  const emailInvalid = Boolean(state.fieldErrors?.email?.length);
  const roleInvalid = Boolean(state.fieldErrors?.role?.length);
  const emailId = `${uid}-email`;
  const roleId = `${uid}-role`;
  const emailHintId = `${uid}-email-hint`;
  const emailErrId = `${uid}-email-error`;
  const roleErrId = `${uid}-role-error`;
  const formError = state.status === "error" && !state.fieldErrors ? t(`errors.${state.code ?? "generic"}`) : "";

  return (
    <div className={styles.section}>
      <form ref={formRef} action={formAction} className="form">
        <input type="hidden" name="uiLocale" value={uiLocale} />
        <input type="hidden" name="organization_id" value={organizationId} />
        <input type="hidden" name="idempotency_key" value={key} />

        <div className="field">
          <label htmlFor={emailId}>{t("fields.email")}</label>
          <input
            id={emailId}
            name="email"
            type="email"
            dir="ltr"
            inputMode="email"
            autoComplete="off"
            required
            maxLength={254}
            aria-invalid={emailInvalid}
            aria-describedby={emailInvalid ? `${emailHintId} ${emailErrId}` : emailHintId}
          />
          <span id={emailHintId} className="hint">
            {t("invite.hints.email")}
          </span>
          {emailInvalid ? (
            <p id={emailErrId} className="notice notice-error">
              {t("errors.invalid_input")}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor={roleId}>{t("fields.role")}</label>
          <select
            id={roleId}
            name="role"
            className={`${styles.select} ${styles.fullSelect}`}
            defaultValue={roleOptions[roleOptions.length - 1]}
            required
            aria-invalid={roleInvalid}
            aria-describedby={roleInvalid ? roleErrId : undefined}
          >
            {roleOptions.map((role) => (
              <option key={role} value={role}>
                {to(`roles.${role}`)}
              </option>
            ))}
          </select>
          {roleInvalid ? (
            <p id={roleErrId} className="notice notice-error">
              {t("errors.invalid_input")}
            </p>
          ) : null}
        </div>

        <div role="alert" aria-live="assertive">
          {formError ? <p className="notice notice-error">{formError}</p> : null}
        </div>

        <button className="btn" type="submit" disabled={pending}>
          {pending ? tc("submitting") : t("invite.submit")}
        </button>
      </form>

      {state.status === "success" && state.invitePath ? <InviteLinkPanel path={state.invitePath} /> : null}
    </div>
  );
}

/**
 * Lien d'invitation, affiché UNE SEULE FOIS : il n'existe qu'ici (seul son hash est stocké). L'URL
 * absolue se construit côté navigateur ; aucune copie n'est faite ailleurs (ni stockage, ni journal).
 */
function InviteLinkPanel({ path }: { path: string }) {
  const t = useTranslations("Members");
  const uid = useId();
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const origin = useSyncExternalStore(
    noopSubscribe,
    () => window.location.origin,
    () => "",
  );
  const url = `${origin}${path}`;

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }

  return (
    <section className={styles.linkBox} aria-labelledby={`${uid}-title`}>
      <h3 id={`${uid}-title`}>{t("inviteLink.title")}</h3>
      <label className={styles.srOnly} htmlFor={`${uid}-url`}>
        {t("inviteLink.label")}
      </label>
      <input
        id={`${uid}-url`}
        className={styles.linkInput}
        type="text"
        readOnly
        dir="ltr"
        value={url}
        aria-describedby={`${uid}-note`}
        onFocus={(event) => event.currentTarget.select()}
      />
      <p id={`${uid}-note`} className="hint">
        {t("inviteLink.note", { days: INVITATION_EXPIRY_DAYS })}
      </p>
      <div className="actions">
        <button className="btn btn-secondary" type="button" onClick={onCopy}>
          {t("inviteLink.copy")}
        </button>
      </div>
      <div role="status" aria-live="polite">
        {copy === "copied" ? <p className="notice notice-success">{t("inviteLink.copied")}</p> : null}
        {copy === "failed" ? <p className="notice notice-error">{t("inviteLink.copyFailed")}</p> : null}
      </div>
    </section>
  );
}
