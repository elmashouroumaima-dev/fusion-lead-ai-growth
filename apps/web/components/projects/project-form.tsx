"use client";

import { PROJECT_NAME_MAX, PROJECT_TYPES, type ProjectType } from "@fusion-leap/domain";
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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

      <div className="grid gap-1.5">
        <Label htmlFor={`${uid}-type`}>{t("form.type")}</Label>
        {editing ? (
          <>
            <p id={`${uid}-type`} className="text-sm font-medium">
              {t(`types.${type}`)}
            </p>
            <p className="text-muted-foreground text-xs">{t("form.typeLocked")}</p>
          </>
        ) : (
          <>
            <Select
              value={type}
              onValueChange={(next) => {
                setType(next as ProjectType);
                setSettings({});
              }}
            >
              <SelectTrigger id={`${uid}-type`} className="w-full sm:w-72" aria-describedby={`${uid}-type-hint`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROJECT_TYPES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`types.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p id={`${uid}-type-hint`} className="text-muted-foreground text-xs">
              {t(`typeHints.${type}`)}
            </p>
          </>
        )}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={nameId}>{t("form.name")}</Label>
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
        <legend className="mb-1 text-sm leading-none font-semibold">{t("form.settings")}</legend>
        <SettingsFields type={type} value={settings} onChange={setSettings} disabled={readOnly} idPrefix={`${uid}-s`} />
      </fieldset>

      <div role="status" aria-live="polite" className="empty:hidden">
        {state.status === "error" ? <p className="text-destructive-text text-sm">{t(`errors.${state.code ?? "generic"}`)}</p> : null}
      </div>

      {readOnly ? null : (
        <Button type="submit" className="w-fit" disabled={pending}>
          {pending ? (editing ? t("form.saving") : t("new.creating")) : editing ? t("form.save") : t("new.submit")}
        </Button>
      )}
    </form>
  );
}
