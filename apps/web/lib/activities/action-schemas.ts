import {
  CALL_OUTCOMES,
  completeTaskSchema,
  createActivitySchema,
  type CompleteTaskInput,
  type CreateActivityInput,
} from "@fusion-leap/domain";
import type { ServiceSchema } from "../service/with-service";

/**
 * Schémas des Server Actions Activités : les champs de formulaire (tous des textes) deviennent les entrées des schémas métier du
 * domaine. L'écran ne propose que la note, l'appel et la tâche (l'e-mail et le rendez-vous existent dans le domaine mais pas dans
 * cet écran). `organization_id` n'est jamais une vérité : le pipeline le compare au contexte vérifié.
 */

type Raw = Record<string, string | undefined>;

type Parsed<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: ReadonlyArray<{ code: string; path: PropertyKey[] }> } };

function through<T>(build: (raw: Raw) => unknown, schema: { safeParse(input: unknown): Parsed<T> }): ServiceSchema<T> {
  return { safeParse: (raw) => schema.safeParse(build(raw as Raw)) };
}

const blankToUndefined = (value: string | undefined): string | undefined => (value === undefined || value.trim() === "" ? undefined : value);

/**
 * Échéance saisie comme une DATE (`AAAA-MM-JJ`) : enregistrée à midi UTC, pour que le jour affiché reste le même dans tous les
 * fuseaux proches. Tout autre format est transmis tel quel et refusé par le schéma.
 */
export function dueDateToIso(value: string | undefined): string | undefined {
  const text = blankToUndefined(value);
  if (text === undefined) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T12:00:00Z` : text;
}

/** Durée d'appel saisie en minutes : entier ; un texte illisible est transmis tel quel et refusé par le schéma. */
function minutes(value: string | undefined): number | string | undefined {
  const text = blankToUndefined(value);
  if (text === undefined) return undefined;
  return /^\d{1,4}$/.test(text.trim()) ? Number(text.trim()) : text;
}

const withText = (text: string | undefined) => (text === undefined ? {} : { text });

/** Types proposés par l'écran. */
export const LEAD_FORM_TYPES = ["note", "call", "task"] as const;

export const createActivityFormSchema: ServiceSchema<CreateActivityInput> = through((r) => {
  const text = blankToUndefined(r.text);
  const base = { lead_id: r.lead_id, organization_id: blankToUndefined(r.organization_id) };
  switch (r.type) {
    case "note":
      return { ...base, type: "note", metadata: { text: text ?? "" } };
    case "call": {
      const outcome = blankToUndefined(r.outcome);
      const duration = minutes(r.duration_minutes);
      return {
        ...base,
        type: "call",
        metadata: { ...withText(text), ...(outcome === undefined ? {} : { outcome }), ...(duration === undefined ? {} : { duration_minutes: duration }) },
      };
    }
    case "task":
      return { ...base, type: "task", metadata: { title: blankToUndefined(r.title) ?? "", ...withText(text) }, due_at: dueDateToIso(r.due_date) ?? null };
    default:
      // Tout autre type (e-mail, rendez-vous, étape, assignation) est refusé ici : rien n'est deviné.
      return { ...base, type: "invalid", metadata: {} };
  }
}, createActivitySchema);

export const completeTaskFormSchema: ServiceSchema<CompleteTaskInput> = through(
  (r) => ({ activity_id: r.activity_id, done: r.done === "true", organization_id: blankToUndefined(r.organization_id) }),
  completeTaskSchema,
);

export const ACTIVITY_CREATE_FIELDS = ["lead_id", "type", "text", "title", "outcome", "duration_minutes", "due_date", "organization_id"] as const;
export const TASK_COMPLETE_FIELDS = ["activity_id", "done", "organization_id"] as const;

export { CALL_OUTCOMES };
