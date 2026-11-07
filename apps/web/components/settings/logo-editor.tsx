"use client";

import {
  LOGO_MIMES,
  MAX_LOGO_BYTES,
  decodeBase64,
  detectImageMime,
  type Logo,
} from "@fusion-leap/domain";
import { useLocale, useTranslations } from "next-intl";
import Image from "next/image";
import { useActionState, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { resetLogoAction, saveLogoAction } from "../../lib/settings/actions";
import type { SettingsActionState } from "../../lib/settings/types";

type Props = {
  /** URL versionnée du logo actuel (ou null : logo par défaut). */
  currentSrc: string | null;
};

type Pending = { logo: Logo; previewUrl: string };
type LocalError = "type" | "size" | "read";

const initialState: SettingsActionState = { status: "idle" };

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Carte « Logo » : choix d'un fichier (PNG, JPEG, WebP ≤ 128 Ko), aperçu, enregistrement, retour au logo par défaut. */
export function LogoEditor({ currentSrc }: Props) {
  const t = useTranslations("Settings");
  const uiLocale = useLocale();
  const inputId = useId();
  const [pending, setPending] = useState<Pending | null>(null);
  const [localError, setLocalError] = useState<LocalError | null>(null);
  const [saveState, saveAction, saving] = useActionState(
    async (prev: SettingsActionState, formData: FormData) => {
      const result = await saveLogoAction(prev, formData);
      if (result.status === "success") setPending(null);
      return result;
    },
    initialState,
  );
  const [resetState, resetAction, resetting] = useActionState(resetLogoAction, initialState);

  useEffect(() => {
    if (saveState.status === "success") toast.success(t("logo.saved"));
  }, [saveState, t]);
  useEffect(() => {
    if (resetState.status === "success") toast.success(t("logo.resetDone"));
  }, [resetState, t]);

  const onFile = async (file: File | undefined) => {
    setLocalError(null);
    setPending(null);
    if (!file) return;
    if (file.size > MAX_LOGO_BYTES) return setLocalError("size");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const mime = detectImageMime(bytes);
      // Le type est déduit des OCTETS (jamais du nom ni du type annoncé par le navigateur).
      if (mime === null || !LOGO_MIMES.includes(mime)) return setLocalError("type");
      const data = toBase64(bytes);
      if (decodeBase64(data) === null) return setLocalError("read");
      setPending({
        logo: { mime, data },
        previewUrl: URL.createObjectURL(new Blob([bytes.slice()], { type: mime })),
      });
    } catch {
      setLocalError("read");
    }
  };

  const shown = pending?.previewUrl ?? currentSrc;
  const error = localError
    ? t(`logo.errors.${localError}`)
    : saveState.status === "error"
      ? t(`errors.${saveState.code ?? "generic"}`)
      : resetState.status === "error"
        ? t(`errors.${resetState.code ?? "generic"}`)
        : null;

  return (
    <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="bg-muted flex size-20 items-center justify-center overflow-hidden rounded-lg border">
            {shown ? (
              // `unoptimized` : aperçu local (blob) ou logo servi par notre route.
              <Image
                src={shown}
                alt={t("logo.previewAlt")}
                unoptimized
                width={80}
                height={80}
                className="size-full object-contain"
              />
            ) : (
              <span className="text-muted-foreground px-2 text-center text-xs">
                {t("logo.default")}
              </span>
            )}
          </div>
          <div className="grid gap-2">
            <label htmlFor={inputId} className="text-sm font-medium">
              {t("logo.choose")}
            </label>
            <input
              id={inputId}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => void onFile(e.target.files?.[0])}
              className="text-sm file:me-3 file:rounded-md file:border file:bg-transparent file:px-3 file:py-1.5 file:text-sm"
            />
            <p className="text-muted-foreground text-xs">{t("logo.hint")}</p>
          </div>
        </div>

        <div role="status" aria-live="polite" className="empty:hidden">
          {error ? <p className="text-destructive-text text-sm">{error}</p> : null}
        </div>

        <div className="flex flex-wrap gap-3">
          <form action={saveAction}>
            <input type="hidden" name="uiLocale" value={uiLocale} />
            <input type="hidden" name="logo" value={pending ? JSON.stringify(pending.logo) : ""} />
            <Button type="submit" disabled={!pending || saving}>
              {saving ? t("saving") : t("logo.save")}
            </Button>
          </form>
          <form action={resetAction}>
            <input type="hidden" name="uiLocale" value={uiLocale} />
            <Button type="submit" variant="outline" disabled={resetting}>
              {t("logo.reset")}
            </Button>
          </form>
        </div>
    </div>
  );
}
