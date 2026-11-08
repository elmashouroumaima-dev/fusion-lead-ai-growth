"use client";

import type { ProjectType } from "@fusion-leap/domain";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { SettingsValue } from "../../lib/projects/settings-form";

type Props = {
  type: ProjectType;
  value: SettingsValue;
  onChange: (next: SettingsValue) => void;
  disabled?: boolean;
  /** Préfixe des identifiants (plusieurs formulaires peuvent coexister sur une page). */
  idPrefix: string;
};

type Row = Record<string, string>;
type Column = { key: string; label: string; multiline?: boolean; ltr?: boolean };

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-muted-foreground text-xs">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Champs de réglages d'un projet selon son TYPE (spec §4). L'état est un objet simple : les listes sont du texte multiligne
 * (une ligne par élément), les tableaux (pages d'atterrissage, FAQ, champs nommés) sont des lignes modifiables. La forme finale
 * est nettoyée avant l'envoi (`cleanSettings`) puis revalidée par le serveur.
 */
export function SettingsFields({ type, value, onChange, disabled = false, idPrefix }: Props) {
  const t = useTranslations("Projects");
  const set = (key: string, next: unknown) => onChange({ ...value, [key]: next });
  const text = (key: string): string => (typeof value[key] === "string" ? (value[key] as string) : "");
  const rowsOf = (key: string): Row[] => (Array.isArray(value[key]) ? (value[key] as Row[]) : []);

  const line = (key: string, label: string, options: { ltr?: boolean; type?: string } = {}) => (
    <Field key={key} id={`${idPrefix}-${key}`} label={label}>
      <Input
        id={`${idPrefix}-${key}`}
        value={text(key)}
        disabled={disabled}
        type={options.type ?? "text"}
        {...(options.ltr ? { dir: "ltr" } : {})}
        onChange={(e) => set(key, e.target.value)}
      />
    </Field>
  );

  const area = (key: string, label: string, options: { lines?: boolean } = {}) => (
    <Field key={key} id={`${idPrefix}-${key}`} label={label} {...(options.lines ? { hint: t("form.linesHint") } : {})}>
      <Textarea
        id={`${idPrefix}-${key}`}
        value={text(key)}
        disabled={disabled}
        rows={options.lines ? 4 : 3}
        aria-describedby={options.lines ? `${idPrefix}-${key}-hint` : undefined}
        onChange={(e) => set(key, e.target.value)}
      />
    </Field>
  );

  const rows = (key: string, label: string, columns: Column[], blank: Row) => {
    const current = rowsOf(key);
    const update = (index: number, column: string, next: string) =>
      set(key, current.map((row, i) => (i === index ? { ...row, [column]: next } : row)));
    return (
      <fieldset key={key} className="grid gap-3" disabled={disabled}>
        <legend className="mb-1 text-sm leading-none font-medium">{label}</legend>
        {current.map((row, index) => (
          <div key={index} className="grid gap-2 rounded-lg border p-3">
            {columns.map((column) => {
              const id = `${idPrefix}-${key}-${index}-${column.key}`;
              return (
                <div key={column.key} className="grid gap-1">
                  <Label htmlFor={id} className="text-muted-foreground text-xs">
                    {column.label}
                  </Label>
                  {column.multiline ? (
                    <Textarea id={id} rows={2} value={row[column.key] ?? ""} onChange={(e) => update(index, column.key, e.target.value)} />
                  ) : (
                    <Input id={id} value={row[column.key] ?? ""} {...(column.ltr ? { dir: "ltr" } : {})} onChange={(e) => update(index, column.key, e.target.value)} />
                  )}
                </div>
              );
            })}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-fit"
              onClick={() => set(key, current.filter((_, i) => i !== index))}
            >
              <Trash2Icon aria-hidden="true" />
              {t("form.remove")}
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => set(key, [...current, blank])}>
          <PlusIcon aria-hidden="true" />
          {t("form.add")}
        </Button>
      </fieldset>
    );
  };

  switch (type) {
    case "website_sales":
      return (
        <div className="grid gap-4">
          {area("offers", t("fields.offers"), { lines: true })}
          {area("business_models", t("fields.business_models"), { lines: true })}
          {line("target_market", t("fields.target_market"))}
          {area("qualification_questions", t("fields.qualification_questions"), { lines: true })}
          {rows(
            "landing_pages",
            t("fields.landing_pages"),
            [
              { key: "name", label: t("fields.landing_page_name") },
              { key: "url", label: t("fields.landing_page_url"), ltr: true },
            ],
            { name: "", url: "" },
          )}
        </div>
      );
    case "salla_app":
      return (
        <div className="grid gap-4">
          {line("app_name", t("fields.app_name"))}
          {area("problem_solved", t("fields.problem_solved"))}
          {area("merchant_segments", t("fields.merchant_segments"), { lines: true })}
          {line("store_url", t("fields.store_url"), { ltr: true, type: "url" })}
          {area("activation_flow", t("fields.activation_flow"))}
          {line("test_pricing", t("fields.test_pricing"))}
          {rows(
            "faqs",
            t("fields.faqs"),
            [
              { key: "question", label: t("fields.faq_question") },
              { key: "answer", label: t("fields.faq_answer"), multiline: true },
            ],
            { question: "", answer: "" },
          )}
        </div>
      );
    case "salla_theme":
      return (
        <div className="grid gap-4">
          {line("preview_url", t("fields.preview_url"), { ltr: true, type: "url" })}
          {area("sectors", t("fields.sectors"), { lines: true })}
          {area("features", t("fields.features"), { lines: true })}
          {area("ad_scenarios", t("fields.ad_scenarios"), { lines: true })}
        </div>
      );
    case "custom":
      return (
        <div className="grid gap-4">
          {area("notes", t("fields.notes"))}
          {rows(
            "fields_rows",
            t("fields.custom_fields"),
            [
              { key: "key", label: t("fields.custom_key"), ltr: true },
              { key: "value", label: t("fields.custom_value") },
            ],
            { key: "", value: "" },
          )}
        </div>
      );
  }
}
