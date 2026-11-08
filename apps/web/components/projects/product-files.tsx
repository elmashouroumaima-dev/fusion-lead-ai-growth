"use client";

import { FileTextIcon, Trash2Icon, UploadIcon } from "lucide-react";
import Image from "next/image";
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useEffect, useId, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { removeProductAssetAction, uploadProductAssetAction } from "../../lib/projects/actions";
import type { AssetLink } from "../../lib/projects/assets";
import type { ProjectsActionState } from "../../lib/projects/types";

type Props = {
  organizationId: string;
  productId: string;
  files: readonly AssetLink[];
};

const initialState: ProjectsActionState = { status: "idle" };

function RemoveFile({ organizationId, productId, file }: { organizationId: string; productId: string; file: AssetLink }) {
  const t = useTranslations("Projects");
  const uiLocale = useLocale();
  const [state, formAction, pending] = useActionState(removeProductAssetAction, initialState);

  useEffect(() => {
    if (state.status === "success" && state.success) toast.success(t(`success.${state.success}`));
  }, [state, t]);

  return (
    <form action={formAction} className="grid gap-1">
      <input type="hidden" name="uiLocale" value={uiLocale} />
      <input type="hidden" name="organization_id" value={organizationId} />
      <input type="hidden" name="product_id" value={productId} />
      <input type="hidden" name="path" value={file.path} />
      <Button type="submit" variant="ghost" size="sm" disabled={pending} aria-label={t("files.removeNamed", { name: file.name })}>
        <Trash2Icon aria-hidden="true" />
        {t("files.remove")}
      </Button>
      <div role="status" aria-live="polite" className="empty:hidden">
        {state.status === "error" ? <p className="text-destructive-text text-xs">{t(`errors.${state.code ?? "generic"}`)}</p> : null}
      </div>
    </form>
  );
}

/**
 * Fichiers d'un produit existant : liste (aperçu des images, téléchargement des PDF par liens signés de 60 s), envoi d'un fichier
 * et retrait. Formulaires distincts du formulaire du produit (jamais imbriqués). Le serveur contrôle le rôle, le type RÉEL, la
 * taille et le projet ; ceci n'est qu'une commodité.
 */
export function ProductFiles({ organizationId, productId, files }: Props) {
  const t = useTranslations("Projects");
  const uiLocale = useLocale();
  const uid = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState(
    async (prev: ProjectsActionState, formData: FormData) => {
      const result = await uploadProductAssetAction(prev, formData);
      if (result.status === "success") formRef.current?.reset();
      return result;
    },
    initialState,
  );

  useEffect(() => {
    if (state.status === "success" && state.success) toast.success(t(`success.${state.success}`));
  }, [state, t]);

  return (
    <section aria-labelledby={`${uid}-title`} className="grid gap-3 border-t pt-4">
      <h3 id={`${uid}-title`} className="text-sm leading-none font-semibold">
        {t("files.title")}
      </h3>

      {files.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("files.empty")}</p>
      ) : (
        <ul className="grid gap-2">
          {files.map((file) => (
            <li key={file.path} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2">
              <div className="flex min-w-0 items-center gap-2">
                {file.image && file.url ? (
                  // Lien signé de 60 s : l'optimiseur d'images n'apporterait rien (l'URL change à chaque affichage).
                  <Image src={file.url} alt={file.name} width={48} height={48} unoptimized className="size-12 shrink-0 rounded object-cover" />
                ) : (
                  <FileTextIcon className="text-muted-foreground size-6 shrink-0" aria-hidden="true" />
                )}
                {file.url ? (
                  <a
                    href={file.url}
                    {...(file.image ? { target: "_blank" } : {})}
                    rel="noopener noreferrer"
                    dir="ltr"
                    className="text-primary-text truncate text-sm underline underline-offset-2"
                    aria-label={file.image ? t("files.open", { name: file.name }) : t("files.download", { name: file.name })}
                  >
                    {file.name}
                  </a>
                ) : (
                  <span dir="ltr" className="truncate text-sm" title={t("files.unavailable")}>
                    {file.name}
                  </span>
                )}
              </div>
              <RemoveFile organizationId={organizationId} productId={productId} file={file} />
            </li>
          ))}
        </ul>
      )}

      <form ref={formRef} action={formAction} className="grid gap-2">
        <input type="hidden" name="uiLocale" value={uiLocale} />
        <input type="hidden" name="organization_id" value={organizationId} />
        <input type="hidden" name="product_id" value={productId} />
        <Label htmlFor={`${uid}-file`}>{t("files.choose")}</Label>
        <Input id={`${uid}-file`} name="file" type="file" required accept=".png,.jpg,.jpeg,.webp,.pdf,image/png,image/jpeg,image/webp,application/pdf" aria-describedby={`${uid}-hint`} />
        <p id={`${uid}-hint`} className="text-muted-foreground text-xs">
          {t("files.hint")}
        </p>
        <div role="status" aria-live="polite" className="empty:hidden">
          {state.status === "error" ? <p className="text-destructive-text text-sm">{t(`errors.${state.code ?? "generic"}`)}</p> : null}
        </div>
        <Button type="submit" variant="outline" size="sm" className="w-fit" disabled={pending}>
          <UploadIcon aria-hidden="true" />
          {pending ? t("files.uploading") : t("files.upload")}
        </Button>
      </form>
    </section>
  );
}
