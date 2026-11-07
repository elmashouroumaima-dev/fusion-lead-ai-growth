"use client";

import { HEX_COLOR } from "@fusion-leap/domain";
import { CheckIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** Palette de couleurs proposée (8 colonnes) : neutres, chauds, verts, bleus/violets, roses/bruns. */
const SWATCHES: readonly string[] = [
  "#ffffff", "#f4f4f5", "#d4d4d8", "#71717a", "#3f3f46", "#18181b", "#09090b", "#000000",
  "#b91c1c", "#dc2626", "#c2410c", "#ea580c", "#fb923c", "#d97706", "#f59e0b", "#facc15",
  "#14532d", "#006a4e", "#15803d", "#16a34a", "#34d399", "#0d9488", "#14b8a6", "#06b6d4",
  "#1e3a8a", "#1d4ed8", "#2563eb", "#60a5fa", "#4f46e5", "#6d28d9", "#a78bfa", "#c026d3",
  "#9d174d", "#db2777", "#f472b6", "#ae2b2f", "#d04a4e", "#78350f", "#854d0e", "#0f172a",
];

type Props = {
  label: string;
  value: string;
  onChange: (hex: string) => void;
};

/**
 * Une couleur : pastille cliquable qui ouvre, sous la ligne, la palette (grille de pastilles), un sélecteur
 * libre et un champ hex. Seules des valeurs #rrggbb en minuscules sont émises vers le parent.
 */
export function ColorField({ label, value, onChange }: Props) {
  const t = useTranslations("Settings");
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const panelId = `${uid}-panel`;

  const commit = (raw: string) => {
    const hex = raw.trim().toLowerCase();
    if (HEX_COLOR.test(hex)) onChange(hex);
  };

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={`${uid}-btn`} className="font-normal">
          {label}
        </Label>
        <div className="flex items-center gap-2">
          <code dir="ltr" className="text-muted-foreground text-xs">
            {value}
          </code>
          <button
            id={`${uid}-btn`}
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={`${label} ${value}`}
            onClick={() => setOpen((o) => !o)}
            className="border-input focus-visible:ring-ring/50 size-9 cursor-pointer rounded-md border focus-visible:ring-[3px] focus-visible:outline-none"
            style={{ backgroundColor: value }}
          />
        </div>
      </div>

      {open ? (
        <div id={panelId} className="bg-card grid gap-3 rounded-md border p-3">
          <div className="grid grid-cols-8 gap-2" role="group" aria-label={t("picker.palette")}>
            {SWATCHES.map((hex) => (
              <button
                key={hex}
                type="button"
                aria-label={hex}
                aria-pressed={hex === value}
                onClick={() => {
                  setDraft(null);
                  onChange(hex);
                }}
                className={cn(
                  "border-input focus-visible:ring-ring/50 relative flex aspect-square w-full items-center justify-center rounded-md border focus-visible:ring-[3px] focus-visible:outline-none",
                  hex === value && "ring-foreground ring-2 ring-offset-1",
                )}
                style={{ backgroundColor: hex }}
              >
                {hex === value ? <CheckIcon aria-hidden="true" className="size-4 mix-blend-difference" color="#ffffff" /> : null}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <span>{t("picker.custom")}</span>
              <input
                type="color"
                value={value}
                onChange={(e) => {
                  setDraft(null);
                  commit(e.target.value);
                }}
                className="border-input size-9 cursor-pointer rounded-md border bg-transparent p-1"
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <span>{t("picker.hex")}</span>
              <input
                dir="ltr"
                inputMode="text"
                maxLength={7}
                spellCheck={false}
                autoComplete="off"
                value={draft ?? value}
                onChange={(e) => {
                  setDraft(e.target.value);
                  commit(e.target.value);
                }}
                onBlur={() => setDraft(null)}
                aria-invalid={draft !== null && !HEX_COLOR.test(draft.trim().toLowerCase())}
                className="border-input bg-background h-9 w-28 rounded-md border px-2 font-mono text-sm"
              />
            </label>
          </div>
        </div>
      ) : null}
    </div>
  );
}
