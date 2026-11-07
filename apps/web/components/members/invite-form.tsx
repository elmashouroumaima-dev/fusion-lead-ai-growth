"use client";

import { INVITATION_EXPIRY_DAYS, type TenantRole } from "@fusion-leap/domain";
import { CheckIcon, CopyIcon, UserPlusIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { inviteMemberAction } from "../../lib/members/actions";
import { shouldRenewIdempotencyKey } from "../../lib/members/idempotency-key";
import type { MembersActionState } from "../../lib/members/types";

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
  const [open, setOpen] = useState(false);
  // Réponse dont le lien a été masqué (fermeture de la fenêtre) : un lien « affiché une fois » ne revient pas.
  const [dismissed, setDismissed] = useState<MembersActionState | null>(null);
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
    if (state.status === "success") {
      formRef.current?.reset();
      toast.success(t("invite.created"));
    }
    // Les erreurs de champ restent sous le champ ; seule une erreur générale devient une notification.
    if (state.status === "error" && !state.fieldErrors) toast.error(t(`errors.${state.code ?? "generic"}`));
  }, [state, t]);

  const emailInvalid = Boolean(state.fieldErrors?.email?.length);
  const roleInvalid = Boolean(state.fieldErrors?.role?.length);
  const emailId = `${uid}-email`;
  const roleId = `${uid}-role`;
  const emailHintId = `${uid}-email-hint`;
  const emailErrId = `${uid}-email-error`;
  const roleErrId = `${uid}-role-error`;
  const formError = state.status === "error" && !state.fieldErrors ? t(`errors.${state.code ?? "generic"}`) : "";
  const linkPath = state.status === "success" && state.invitePath && dismissed !== state ? state.invitePath : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setDismissed(state);
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button">
          <UserPlusIcon aria-hidden="true" />
          {t("invite.open")}
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={t("dialog.close")}>
        <DialogHeader>
          <DialogTitle>{t("invite.title")}</DialogTitle>
          <DialogDescription>{t("invite.description")}</DialogDescription>
        </DialogHeader>

        <form ref={formRef} action={formAction} className="grid gap-4">
          <input type="hidden" name="uiLocale" value={uiLocale} />
          <input type="hidden" name="organization_id" value={organizationId} />
          <input type="hidden" name="idempotency_key" value={key} />

          <div className="grid gap-2">
            <Label htmlFor={emailId}>{t("fields.email")}</Label>
            <Input
              id={emailId}
              name="email"
              type="email"
              dir="ltr"
              inputMode="email"
              autoComplete="off"
              required
              maxLength={254}
              error={emailInvalid}
              aria-describedby={emailInvalid ? `${emailHintId} ${emailErrId}` : emailHintId}
            />
            <p id={emailHintId} className="text-muted-foreground text-xs">
              {t("invite.hints.email")}
            </p>
            {emailInvalid ? (
              <p id={emailErrId} className="text-destructive-text text-sm">
                {t("errors.invalid_input")}
              </p>
            ) : null}
          </div>

          <div className="grid gap-2">
            <Label htmlFor={roleId}>{t("fields.role")}</Label>
            <Select name="role" defaultValue={roleOptions[roleOptions.length - 1]} required>
              <SelectTrigger id={roleId} className="w-full" aria-invalid={roleInvalid} aria-describedby={roleInvalid ? roleErrId : undefined}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roleOptions.map((role) => (
                  <SelectItem key={role} value={role}>
                    {to(`roles.${role}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {roleInvalid ? (
              <p id={roleErrId} className="text-destructive-text text-sm">
                {t("errors.invalid_input")}
              </p>
            ) : null}
          </div>

          <div role="alert" aria-live="assertive" className="empty:hidden">
            {formError ? <p className="text-destructive-text text-sm">{formError}</p> : null}
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? tc("submitting") : t("invite.submit")}
            </Button>
          </DialogFooter>
        </form>

        {linkPath ? <InviteLinkPanel path={linkPath} /> : null}
      </DialogContent>
    </Dialog>
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
      toast.success(t("inviteLink.copied"));
    } catch {
      // Échec : annoncé uniquement par la région live ci-dessous (un seul canal, pas de toast d'erreur).
      setCopy("failed");
    }
  }

  return (
    <Alert variant="success" role="group">
      <AlertTitle>{t("inviteLink.title")}</AlertTitle>
      <AlertDescription className="col-start-2 grid gap-3">
        <Label htmlFor={`${uid}-url`} className="sr-only">
          {t("inviteLink.label")}
        </Label>
        <div className="flex items-center gap-2">
          <Input
            id={`${uid}-url`}
            type="text"
            readOnly
            dir="ltr"
            value={url}
            aria-describedby={`${uid}-note`}
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button type="button" variant="outline" onClick={onCopy} className="text-foreground">
            {copy === "copied" ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
            {t("inviteLink.copy")}
          </Button>
        </div>
        <p id={`${uid}-note`} className="text-xs">
          {t("inviteLink.note", { days: INVITATION_EXPIRY_DAYS })}
        </p>
        <div role="status" aria-live="polite" className="empty:hidden">
          {copy === "copied" ? <p className="text-sm">{t("inviteLink.copied")}</p> : null}
          {copy === "failed" ? <p className="text-destructive-text text-sm">{t("inviteLink.copyFailed")}</p> : null}
        </div>
      </AlertDescription>
    </Alert>
  );
}
