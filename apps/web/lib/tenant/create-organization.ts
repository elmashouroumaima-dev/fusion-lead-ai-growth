import {
  uuidSchema,
  type CreateOrganizationInput,
  type OrganizationSummary,
  type TenantRole,
} from "@fusion-leap/domain";
import type { ApiErrorCode } from "../api/errors";
import { mapDbError } from "../api/map-db-error";
import type { ServerSupabase } from "./identity";
import { fetchActiveMemberships } from "./memberships";

export type CreateOrganizationResult =
  | { ok: true; created: boolean; organization: OrganizationSummary; role: TenantRole }
  | { ok: false; code: ApiErrorCode };

/**
 * Crée une organisation via la fonction SQL transactionnelle `public.create_organization`
 * (organisation + membre owner + abonnement trial, G-R7), appelée avec les droits de
 * l'utilisateur : l'identité (`auth.uid()`) est lue par la base, jamais fournie par le client.
 *
 * `created` distingue création (true) et rejeu de la même clé d'idempotence (false) : la fonction
 * ne renvoie que l'id, on compare donc aux adhésions connues AVANT l'appel. Aucune donnée
 * saisie, aucun message SQL n'est journalisé : seulement le SQLSTATE et le request_id.
 */
export async function createOrganizationForUser(
  supabase: ServerSupabase,
  userId: string,
  input: CreateOrganizationInput,
  creationKey: string,
  requestId?: string,
): Promise<CreateOrganizationResult> {
  try {
    const before = await fetchActiveMemberships(supabase, userId);

    const { data, error } = await supabase.rpc("create_organization", {
      p_name: input.name,
      p_locale: input.locale,
      p_timezone: input.timezone,
      p_creation_key: creationKey,
    });
    if (error) {
      const code = mapDbError(error);
      if (code === "internal_error") {
        console.error(JSON.stringify({ event: "org_create_failed", db_code: error.code ?? null, request_id: requestId ?? null }));
      }
      return { ok: false, code };
    }

    const organizationId = uuidSchema.safeParse(data);
    if (!organizationId.success) return { ok: false, code: "internal_error" };

    const after = await fetchActiveMemberships(supabase, userId);
    const membership = after.find((m) => m.organizationId === organizationId.data);
    // Rejeu après retrait / suspension : la fonction a réussi mais l'adhésion n'est plus active.
    // Cas normal (pas une panne) : refus ordinaire, sans journal d'erreur.
    if (!membership) return { ok: false, code: "forbidden" };

    const { id, name, slug, locale, timezone } = membership.organization;
    return {
      ok: true,
      created: !before.some((m) => m.organizationId === organizationId.data),
      organization: { id, name, slug, locale, timezone },
      role: membership.role,
    };
  } catch {
    console.error(JSON.stringify({ event: "org_create_failed", request_id: requestId ?? null }));
    return { ok: false, code: "internal_error" };
  }
}
