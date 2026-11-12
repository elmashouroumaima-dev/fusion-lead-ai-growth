"use client";

import type { ProjectStatus } from "@fusion-leap/domain";
import { ArchiveIcon, ArchiveRestoreIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { setProjectStatusAction } from "../../lib/projects/actions";
import type { ProjectsActionState } from "../../lib/projects/types";

type Props = { organizationId: string; projectId: string; status: ProjectStatus };

const initialState: ProjectsActionState = { status: "idle" };

/**
 * Archive (avec confirmation : le projet devient lecture seule) ou réactive un projet. La réactivation consomme de nouveau
 * le quota du plan : si la limite est atteinte, l'erreur « quota » s'affiche (notification rouge et message).
 */
export function ProjectStatusButton({ organizationId, projectId, status }: Props) {
  const t = useTranslations("Projects");
  const uiLocale = useLocale();
  const archiving = status === "active";
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(async (prev: ProjectsActionState, formData: FormData) => {
    const result = await setProjectStatusAction(prev, formData);
    if (result.status === "success") setOpen(false);
    return result;
  }, initialState);

  useEffect(() => {
    if (state.status === "success" && state.success) toast.success(t(`success.${state.success}`));
  }, [state, t]);

  const form = (
    <form action={formAction} className="grid gap-3">
      <input type="hidden" name="uiLocale" value={uiLocale} />
      <input type="hidden" name="organization_id" value={organizationId} />
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="status" value={archiving ? "archived" : "active"} />
      <div role="status" aria-live="polite" className="empty:hidden">
        {state.status === "error" ? <p className="text-destructive-text text-sm">{t(`errors.${state.code ?? "generic"}`)}</p> : null}
      </div>
      {archiving ? (
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            {t("detail.cancel")}
          </Button>
          <Button type="submit" variant="destructive" disabled={pending}>
            {t("detail.confirm")}
          </Button>
        </DialogFooter>
      ) : (
        <Button type="submit" variant="outline" className="w-fit" disabled={pending}>
          <ArchiveRestoreIcon aria-hidden="true" />
          {t("detail.reactivate")}
        </Button>
      )}
    </form>
  );

  if (!archiving) return form;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <ArchiveIcon aria-hidden="true" />
          {t("detail.archive")}
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={t("products.close")}>
        <DialogHeader>
          <DialogTitle>{t("detail.archiveTitle")}</DialogTitle>
          <DialogDescription>{t("detail.archiveConfirm")}</DialogDescription>
        </DialogHeader>
        {form}
      </DialogContent>
    </Dialog>
  );
}
