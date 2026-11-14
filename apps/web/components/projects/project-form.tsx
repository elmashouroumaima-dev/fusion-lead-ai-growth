"use client";

import { PROJECT_NAME_MAX, PROJECT_TYPES, type ProjectType } from "@fusion-leap/domain";
import { GlobeIcon, PaletteIcon, PuzzleIcon, ShoppingBagIcon, type LucideIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buttonVariants } from "@/components/ui/button";
import { Link } from "../../i18n/navigation";
import { cn } from "@/lib/utils";
import { createProjectAction, updateProjectAction } from "../../lib/projects/actions";
import { cleanSettings, settingsToFormState, type SettingsValue } from "../../lib/projects/settings-form";
import type { ProjectsActionState } from "../../lib/projects/types";
import { SettingsFields } from "./settings-fields";

type Props = {
  organizationId: string;
  /** Clé d'idempotence générée côté serveur à chaque rendu (création) : un envoi rejoué ne crée pas de doublon. */
  idempotencyKey?: string;
  /** Présent en modification : projet existant (le type n'est pas modifiable). */
  project?: { id: string; type: ProjectType; name: string; settings: SettingsValue };
  /** Lecture seule (rôle sans droit d'écriture, ou projet archivé). */
  readOnly?: boolean;
};

const TYPE_ICONS: Record<ProjectType, LucideIcon> = {
  website_sales: GlobeIcon,
  salla_app: ShoppingBagIcon,
  salla_theme: PaletteIcon,
  custom: PuzzleIcon,
};

const initialState: ProjectsActionState = { status: "idle" };

/**
 * Formulaire d'un projet : création (choix du type puis réglages du type) ou modification (nom et réglages). Les réglages sont
 * regroupés en JSON dans un champ caché avant l'envoi ; le serveur revalide tout (zod, rôle, quota, base).
 */
export function ProjectForm({ organizationId, idempotencyKey, project, readOnly = false }: Props) {
  const t = useTranslations("Projects");
  const uiLocale = useLocale();
  const uid = useId();
  const editing = project !== undefined;
  const [type, setType] = useState<ProjectType>(project?.type ?? "website_sales");
  const [name, setName] = useState(project?.name ?? "");
  const [settings, setSettings] = useState<SettingsValue>(() => (project ? settingsToFormState(project.type, project.settings) : {}));
  const [key, setKey] = useState(idempotencyKey ?? "");
  const [state, formAction, pending] = useActionState(
    async (prev: ProjectsActionState, formData: FormData) => {
      const result = editing ? await updateProjectAction(prev, formData) : await createProjectAction(prev, formData);
      // Nouvelle clé seulement après un conflit : un échec ordinaire se rejoue sans doublon avec la même clé.
      if (result.code === "idempotency_conflict") setKey(crypto.randomUUID());
      return result;
    },
    initialState,
  );

  useEffect(() => {
    if (state.status === "success" && state.success) toast.success(t(`success.${state.success}`));
  }, [state, t]);

  const settingsJson = useMemo(() => JSON.stringify(cleanSettings(type, settings)), [type, settings]);
  const nameInvalid = Boolean(state.fieldErrors?.name?.length);
  const nameId = `${uid}-name`;

  return (
    <form action={formAction} className="grid gap-5" noValidate={false}>
      <input type="hidden" name="uiLocale" value={uiLocale} />
      <input type="hidden" name="organization_id" value={organizationId} />
      <input type="hidden" name="settings" value={settingsJson} />
      {editing ? <input type="hidden" name="project_id" value={project.id} /> : <input type="hidden" name="idempotency_key" value={key} />}
      {editing ? null : <input type="hidden" name="type" value={type} />}

      {editing ? (
        <div className="grid gap-1.5">
          <Label htmlFor={`${uid}-type`}>{t("form.type")}</Label>
          <p id={`${uid}-type`} className="text-sm font-medium">
            {t(`types.${type}`)}
          </p>
          <p className="text-muted-foreground text-xs">{t("form.typeLocked")}</p>
        </div>
      ) : (
        <fieldset className="grid gap-3">
          <legend className="mb-1 flex items-center gap-2 text-sm leading-none font-semibold">
            <span className="bg-primary text-primary-foreground grid size-5 place-items-center rounded-full text-xs" aria-hidden="true">
              1
            </span>
            {t("form.type")}
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {PROJECT_TYPES.map((value) => {
              const Icon = TYPE_ICONS[value];
              return (
                <label key={value} className="relative block cursor-pointer">
                  <input
                    type="radio"
                    name={`${uid}-type-choice`}
                    value={value}
                    checked={type === value}
                    onChange={() => {
                      setType(value);
                      setSettings({});
                    }}
                    className="peer sr-only"
                  />
                  <span
                    className={cn(
                      "bg-background hover:border-brand/60 flex h-full items-start gap-3 rounded-xl border p-4 transition",
                      "peer-checked:border-brand peer-checked:bg-brand/10 peer-checked:ring-brand/30 peer-checked:ring-2",
                      "peer-focus-visible:ring-ring peer-focus-visible:ring-[3px]",
                    )}
                  >
                    <span className="bg-brand/15 text-primary-text grid size-9 shrink-0 place-items-center rounded-lg">
                      <Icon className="size-4" aria-hidden="true" />
                    </span>
                    <span className="grid gap-0.5">
                      <span className="text-sm font-medium">{t(`types.${value}`)}</span>
                      <span className="text-muted-foreground text-xs">{t(`typeHints.${value}`)}</span>
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      <div className="grid gap-1.5 border-t pt-5">
        <Label htmlFor={nameId} className="gap-2">
          {editing ? null : (
            <span className="bg-primary text-primary-foreground grid size-5 place-items-center rounded-full text-xs" aria-hidden="true">
              2
            </span>
          )}
          {t("form.name")}
        </Label>
        <Input
          id={nameId}
          name="name"
          value={name}
          required
          maxLength={PROJECT_NAME_MAX}
          disabled={readOnly}
          error={nameInvalid}
          aria-describedby={`${nameId}-hint`}
          onChange={(e) => setName(e.target.value)}
        />
        <p id={`${nameId}-hint`} className="text-muted-foreground text-xs">
          {t("form.nameHint")}
        </p>
      </div>

      <fieldset className="grid gap-3" disabled={readOnly}>
        <legend className="mb-2 text-sm leading-none font-semibold">{t("form.settings")}</legend>
        <SettingsFields type={type} value={settings} onChange={setSettings} disabled={readOnly} idPrefix={`${uid}-s`} />
      </fieldset>

      <div role="status" aria-live="polite" className="empty:hidden">
        {state.status === "error" ? <p className="text-destructive-text text-sm">{t(`errors.${state.code ?? "generic"}`)}</p> : null}
      </div>

      {readOnly ? null : (
        <div className="bg-card/90 sticky bottom-0 z-10 -mx-6 flex flex-wrap items-center gap-3 border-t px-6 py-4 backdrop-blur">
          <Button type="submit" disabled={pending}>
            {pending ? (editing ? t("form.saving") : t("new.creating")) : editing ? t("form.save") : t("new.submit")}
          </Button>
          {editing ? null : (
            <Link href="/projects" className={buttonVariants({ variant: "ghost" })}>
              {t("new.cancel")}
            </Link>
          )}
        </div>
      )}
    </form>
  );
}
