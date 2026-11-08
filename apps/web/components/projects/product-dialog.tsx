"use client";

import { PRODUCT_KIND_MAX, PRODUCT_OFFER_MAX, PRODUCT_PRICE_HINT_MAX, type ProductRow } from "@fusion-leap/domain";
import { PencilIcon, PlusIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createProductAction, updateProductAction } from "../../lib/projects/actions";
import type { AssetLink } from "../../lib/projects/assets";
import type { ProjectsActionState } from "../../lib/projects/types";
import { ProductFiles } from "./product-files";

type Props = {
  organizationId: string;
  projectId: string;
  /** Présent en modification. */
  product?: ProductRow;
  /** Clé d'idempotence (création), générée côté serveur à chaque rendu de la page. */
  idempotencyKey?: string;
  /** Fichiers du produit (modification) : liens signés de 60 s générés côté serveur. */
  files?: readonly AssetLink[];
};

const initialState: ProjectsActionState = { status: "idle" };

/** Fenêtre d'ajout ou de modification d'un produit (offre, prix indicatif, page d'atterrissage https). */
export function ProductDialog({ organizationId, projectId, product, idempotencyKey, files = [] }: Props) {
  const t = useTranslations("Projects");
  const uiLocale = useLocale();
  const uid = useId();
  const editing = product !== undefined;
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(idempotencyKey ?? "");
  const [state, formAction, pending] = useActionState(
    async (prev: ProjectsActionState, formData: FormData) => {
      const result = editing ? await updateProductAction(prev, formData) : await createProductAction(prev, formData);
      if (result.status === "success" || result.code === "idempotency_conflict") setKey(crypto.randomUUID());
      if (result.status === "success") setOpen(false);
      return result;
    },
    initialState,
  );

  useEffect(() => {
    if (state.status === "success" && state.success) toast.success(t(`success.${state.success}`));
  }, [state, t]);

  const title = editing ? t("products.editTitle") : t("products.addTitle");
  const fieldId = (name: string) => `${uid}-${name}`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {editing ? (
          <Button type="button" variant="ghost" size="sm" aria-label={t("products.editNamed", { name: product.kind })}>
            <PencilIcon aria-hidden="true" />
            {t("products.edit")}
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm">
            <PlusIcon aria-hidden="true" />
            {t("products.add")}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent closeLabel={t("products.close")} className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t("products.assetsSoon")}</DialogDescription>
        </DialogHeader>
        <form action={formAction} className="grid gap-4">
          <input type="hidden" name="uiLocale" value={uiLocale} />
          <input type="hidden" name="organization_id" value={organizationId} />
          {editing ? (
            <>
              <input type="hidden" name="product_id" value={product.id} />
              {/* Les fichiers déjà associés sont conservés tels quels (l'envoi de fichiers arrive avec le Storage). */}
              <input type="hidden" name="assets" value={JSON.stringify(product.assets)} />
            </>
          ) : (
            <>
              <input type="hidden" name="project_id" value={projectId} />
              <input type="hidden" name="idempotency_key" value={key} />
            </>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor={fieldId("kind")}>{t("products.kind")}</Label>
            <Input id={fieldId("kind")} name="kind" required maxLength={PRODUCT_KIND_MAX} defaultValue={product?.kind ?? ""} aria-describedby={fieldId("kind-hint")} />
            <p id={fieldId("kind-hint")} className="text-muted-foreground text-xs">
              {t("products.kindHint")}
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={fieldId("offer")}>{t("products.offer")}</Label>
            <Textarea id={fieldId("offer")} name="offer" required rows={3} maxLength={PRODUCT_OFFER_MAX} defaultValue={product?.offer ?? ""} aria-describedby={fieldId("offer-hint")} />
            <p id={fieldId("offer-hint")} className="text-muted-foreground text-xs">
              {t("products.offerHint")}
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={fieldId("price")}>{t("products.priceHint")}</Label>
            <Input id={fieldId("price")} name="price_hint" maxLength={PRODUCT_PRICE_HINT_MAX} defaultValue={product?.price_hint ?? ""} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={fieldId("url")}>{t("products.landingUrl")}</Label>
            <Input id={fieldId("url")} name="landing_url" type="url" dir="ltr" defaultValue={product?.landing_url ?? ""} />
          </div>

          <div role="status" aria-live="polite" className="empty:hidden">
            {state.status === "error" ? <p className="text-destructive-text text-sm">{t(`errors.${state.code ?? "generic"}`)}</p> : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t("products.cancel")}
            </Button>
            <Button type="submit" disabled={pending}>
              {editing ? t("products.submitEdit") : t("products.submitAdd")}
            </Button>
          </DialogFooter>
        </form>
        {editing ? <ProductFiles organizationId={organizationId} productId={product.id} files={files} /> : null}
      </DialogContent>
    </Dialog>
  );
}
