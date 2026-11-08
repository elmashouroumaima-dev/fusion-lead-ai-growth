"use client";

import {
  DEFAULT_PALETTE,
  PALETTE_MODES,
  PALETTE_PRESETS,
  PALETTE_TOKENS,
  PRESET_IDS,
  TOKEN_CSS_VARIABLES,
  paletteContrastIssues,
  readableTextOn,
  type ModePalette,
  type Palette,
  type PaletteMode,
  type PaletteToken,
} from "@fusion-leap/domain";
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useEffect, useState, type CSSProperties } from "react";
import { toast } from "sonner";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { resetPaletteAction, savePaletteAction } from "../../lib/settings/actions";
import { ColorField } from "./color-field";
import type { SettingsActionState } from "../../lib/settings/types";

type Props = { initial: Palette | null };

const initialState: SettingsActionState = { status: "idle" };

/** Variables CSS de l'aperçu : portées par le conteneur seulement, jamais appliquées au reste de la page. */
function previewStyle(mode: ModePalette): CSSProperties {
  const style: Record<string, string> = {};
  for (const token of PALETTE_TOKENS) for (const variable of TOKEN_CSS_VARIABLES[token]) style[variable] = mode[token];
  return style as CSSProperties;
}

export function PaletteEditor({ initial }: Props) {
  const t = useTranslations("Settings");
  const uiLocale = useLocale();
  const [palette, setPalette] = useState<Palette>(initial ?? DEFAULT_PALETTE);
  const [previewMode, setPreviewMode] = useState<PaletteMode>("light");
  const [saveState, saveAction, saving] = useActionState(savePaletteAction, initialState);
  const [resetState, resetAction, resetting] = useActionState(async (prev: SettingsActionState, formData: FormData) => {
    const result = await resetPaletteAction(prev, formData);
    if (result.status === "success") setPalette(DEFAULT_PALETTE);
    return result;
  }, initialState);

  const issues = paletteContrastIssues(palette);
  const blocked = issues.length > 0;

  useEffect(() => {
    if (saveState.status === "success") toast.success(t("saved"));
    if (saveState.status === "error") toast.error(t(`errors.${saveState.code ?? "generic"}`));
  }, [saveState, t]);
  useEffect(() => {
    if (resetState.status === "success") toast.success(t("resetDone"));
    if (resetState.status === "error") toast.error(t(`errors.${resetState.code ?? "generic"}`));
  }, [resetState, t]);

  // Fond -> texte associé : quand on change un fond, son texte devient automatiquement le plus lisible
  // (clair ou foncé). Il reste modifiable à la main ensuite.
  const TEXT_OF: Partial<Record<PaletteToken, PaletteToken>> = {
    primary: "primary_foreground",
    secondary: "secondary_foreground",
    accent: "accent_foreground",
    destructive: "destructive_foreground",
    background: "foreground",
  };
  const setColor = (mode: PaletteMode, token: PaletteToken, value: string) =>
    setPalette((p) => {
      const hex = value.toLowerCase();
      const next = { ...p[mode], [token]: hex };
      const textToken = TEXT_OF[token];
      if (textToken) next[textToken] = readableTextOn(hex);
      return { ...p, [mode]: next };
    });

  const error = saveState.status === "error" ? saveState.code : resetState.status === "error" ? resetState.code : undefined;

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("presets.title")}</CardTitle>
          <CardDescription>{t("presets.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {PRESET_IDS.map((id) => (
            <Button key={id} type="button" variant="outline" onClick={() => setPalette(PALETTE_PRESETS[id])}>
              <span
                aria-hidden="true"
                className="border-input size-4 rounded-full border"
                style={{ backgroundColor: PALETTE_PRESETS[id].light.primary }}
              />
              {t(`presets.${id}`)}
            </Button>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {PALETTE_MODES.map((mode) => (
          <Card key={mode}>
            <CardHeader>
              <CardTitle>{t(`modes.${mode}`)}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              {PALETTE_TOKENS.map((token) => (
                <ColorField
                  key={token}
                  label={t(`tokens.${token}`)}
                  value={palette[mode][token]}
                  onChange={(hex) => setColor(mode, token, hex)}
                />
              ))}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div className="grid gap-1">
            <CardTitle>{t("preview.title")}</CardTitle>
            <CardDescription>{t("preview.description")}</CardDescription>
          </div>
          <div className="flex gap-2" role="group" aria-label={t("preview.mode")}>
            {PALETTE_MODES.map((mode) => (
              <Button
                key={mode}
                type="button"
                size="sm"
                variant={previewMode === mode ? "default" : "outline"}
                aria-pressed={previewMode === mode}
                onClick={() => setPreviewMode(mode)}
              >
                {t(`modes.${mode}`)}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          <div
            data-testid="palette-preview"
            style={previewStyle(palette[previewMode])}
            className="bg-background text-foreground grid gap-4 rounded-lg border p-5"
          >
            <p className="text-lg font-semibold">{t("preview.sample.heading")}</p>
            <p className="text-sm">{t("preview.sample.text")}</p>
            <span className="text-primary-text w-fit text-sm underline">{t("preview.sample.link")}</span>
            <div className="flex flex-wrap gap-2">
              <span className="bg-primary text-primary-foreground rounded-md px-3 py-2 text-sm">{t("preview.sample.primary")}</span>
              <span className="bg-secondary text-secondary-foreground rounded-md px-3 py-2 text-sm">{t("preview.sample.secondary")}</span>
              <span className="bg-accent text-accent-foreground rounded-md px-3 py-2 text-sm">{t("preview.sample.accent")}</span>
              <span className="bg-destructive text-destructive-foreground rounded-md px-3 py-2 text-sm">{t("preview.sample.destructive")}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {blocked ? (
        <Alert variant="destructive" role="alert">
          <p className="font-medium">{t("contrast.title")}</p>
          <ul className="mt-1 list-disc ps-5 text-sm">
            {issues.map((i) => (
              <li key={`${i.mode}-${i.text}-${i.background}`}>
                {t("contrast.issue", {
                  mode: t(`modes.${i.mode}`),
                  text: t(`tokens.${i.text}`),
                  background: t(`tokens.${i.background}`),
                  ratio: i.ratio,
                })}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <div role="status" aria-live="polite" className="empty:hidden">
        {error ? <p className="text-destructive-text text-sm">{t(`errors.${error}`)}</p> : null}
      </div>

      <div className="flex flex-wrap gap-3">
        <form action={saveAction}>
          <input type="hidden" name="uiLocale" value={uiLocale} />
          <input type="hidden" name="palette" value={JSON.stringify(palette)} />
          <Button type="submit" disabled={blocked || saving}>
            {saving ? t("saving") : t("save")}
          </Button>
        </form>
        <form action={resetAction}>
          <input type="hidden" name="uiLocale" value={uiLocale} />
          <Button type="submit" variant="outline" disabled={resetting}>
            {t("reset")}
          </Button>
        </form>
      </div>
    </div>
  );
}
