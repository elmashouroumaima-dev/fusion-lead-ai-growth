import { deadLetterRowSchema, type DeadLetterRow } from "@fusion-leap/domain";
import { mapLeadsDbError } from "../leads/map-error";
import type { ServiceErrorCode } from "../service/errors";
import type { ServerSupabase } from "../tenant/identity";

/**
 * Exploitation des envois (J39). Client serveur de l'UTILISATEUR : la RLS limite la lecture des jobs à owner / admin et les fonctions SQL
 * revérifient le rôle ; aucune `service_role`. Jamais de charge utile de job ni de contenu de message.
 */
export type OperationsResult<T> = { ok: true; value: T } | { ok: false; code: ServiceErrorCode };
const fail = (code: ServiceErrorCode): { ok: false; code: ServiceErrorCode } => ({ ok: false, code });

/** Pose ou lève l'arrêt d'urgence d'envoi de l'entreprise (owner, admin, marketing manager). */
export async function setEmergencyStop(supabase: ServerSupabase, organizationId: string, paused: boolean): Promise<OperationsResult<true>> {
  const { error } = await supabase.rpc("set_send_emergency_stop", { p_org: organizationId, p_paused: paused });
  return error ? fail(mapLeadsDbError(error)) : { ok: true, value: true };
}

/** Remet une dead letter en file. `false` : le job n'existe pas dans cette entreprise ou n'est pas en dead letter. */
export async function replayDeadLetter(supabase: ServerSupabase, organizationId: string, jobId: string): Promise<OperationsResult<boolean>> {
  const { data, error } = await supabase.rpc("operator_replay_dead_letter", { p_org: organizationId, p_job: jobId });
  if (error) return fail(mapLeadsDbError(error));
  return typeof data === "boolean" ? { ok: true, value: data } : fail("internal_error");
}

/** 50 dernières dead letters de l'entreprise (colonnes sûres seulement). */
export async function listDeadLetters(supabase: ServerSupabase, organizationId: string): Promise<DeadLetterRow[]> {
  const { data, error } = await supabase
    .from("jobs")
    .select("id, kind, attempts, last_error, finished_at")
    .eq("organization_id", organizationId)
    .eq("status", "dead_letter")
    .order("finished_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(50);
  if (error || !Array.isArray(data)) throw new Error("dead_letters_lookup_failed");
  return data.map((row: unknown) => {
    const parsed = deadLetterRowSchema.safeParse(row);
    if (!parsed.success) throw new Error("rows_unreadable");
    return parsed.data;
  });
}

/** L'arrêt d'urgence est-il actif ? (lecture de `organizations.settings.send_paused`, lisible par les membres). */
export async function isEmergencyStopActive(supabase: ServerSupabase, organizationId: string): Promise<boolean> {
  const { data, error } = await supabase.from("organizations").select("settings").eq("id", organizationId).maybeSingle();
  if (error) throw new Error("organization_lookup_failed");
  const settings = (data as { settings?: Record<string, unknown> } | null)?.settings;
  return settings?.send_paused === true;
}
