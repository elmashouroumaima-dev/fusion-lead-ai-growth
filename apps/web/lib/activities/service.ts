import type { ActivityRow, CompleteTaskInput, CreateActivityInput, UpdateTaskInput } from "@fusion-leap/domain";
import type { ServiceErrorCode } from "../service/errors";
import type { ServerSupabase } from "../tenant/identity";
import { mapActivitiesDbError } from "./map-error";
import { getActivity } from "./queries";

/**
 * Opérations sur les activités d'un lead (J20). Chaque écriture passe par une fonction SQL (SECURITY DEFINER) qui relit le rôle de
 * l'appelant (owner / admin, commercial sur SES leads ; marketing et analyste jamais), le projet (archivé = lecture seule),
 * l'abonnement et journalise. L'identifiant d'organisation vient du CONTEXTE VÉRIFIÉ, jamais de l'entrée. Les changements d'étape
 * et d'assignation sont écrits par la base (déclencheurs) : aucune fonction ici pour les créer. Une note, un appel, un e-mail
 * ou un rendez-vous ne se modifie jamais ; seules les tâches évoluent.
 */
export type ActivityResult<T> = { ok: true; value: T } | { ok: false; code: ServiceErrorCode };

const fail = (code: ServiceErrorCode): { ok: false; code: ServiceErrorCode } => ({ ok: false, code });

async function readActivity(supabase: ServerSupabase, organizationId: string, id: string): Promise<ActivityRow | null> {
  try {
    return await getActivity(supabase, organizationId, id);
  } catch {
    return null;
  }
}

/** Journalise une note, un appel, un e-mail (compte rendu), un rendez-vous ou crée une tâche. */
export async function createActivity(
  supabase: ServerSupabase,
  organizationId: string,
  input: CreateActivityInput,
): Promise<ActivityResult<ActivityRow>> {
  const { data, error } = await supabase.rpc("create_activity", {
    p_org: organizationId,
    p_lead: input.lead_id,
    p_type: input.type,
    p_metadata: input.metadata,
    p_due_at: input.due_at ?? null,
    p_owner: input.owner_id ?? null,
  });
  if (error) return fail(mapActivitiesDbError(error));
  if (typeof data !== "string") return fail("internal_error");
  const activity = await readActivity(supabase, organizationId, data);
  return activity ? { ok: true, value: activity } : fail("internal_error");
}

/** Modifie une tâche (contenu, échéance, responsable : absent = inchangé). */
export async function updateTask(supabase: ServerSupabase, organizationId: string, input: UpdateTaskInput): Promise<ActivityResult<ActivityRow>> {
  const { error } = await supabase.rpc("update_task", {
    p_org: organizationId,
    p_id: input.activity_id,
    p_metadata: input.metadata,
    p_due_at: input.due_at ?? null,
    p_owner: input.owner_id ?? null,
  });
  if (error) return fail(mapActivitiesDbError(error));
  const activity = await readActivity(supabase, organizationId, input.activity_id);
  return activity ? { ok: true, value: activity } : fail("internal_error");
}

/** Marque une tâche faite (date posée par la base) ou à refaire. */
export async function completeTask(supabase: ServerSupabase, organizationId: string, input: CompleteTaskInput): Promise<ActivityResult<ActivityRow>> {
  const { error } = await supabase.rpc("complete_task", { p_org: organizationId, p_id: input.activity_id, p_done: input.done });
  if (error) return fail(mapActivitiesDbError(error));
  const activity = await readActivity(supabase, organizationId, input.activity_id);
  return activity ? { ok: true, value: activity } : fail("internal_error");
}
