import "server-only";
import { createWhatsAppCloudClient, type WhatsAppValidation } from "@fusion-leap/adapters";
import { createAdminClient } from "../supabase/admin";
import type { ServerSupabase } from "../tenant/identity";
import { ServiceError } from "./errors";
import { readIntegrationSecret } from "./integration-secrets";

/**
 * Vérification d'une connexion (J34, spec §9.3) : le serveur essaie le jeton de l'intégration auprès du fournisseur puis enregistre le résultat par la
 * fonction `integration_set_validation` (service_role seulement : un utilisateur ne peut jamais déclarer une intégration « active »). L'entreprise
 * est celle du contexte vérifié ; l'intégration est relue AVEC LE CLIENT DE L'UTILISATEUR (RLS : owner et admin de cette entreprise), le jeton
 * n'est déchiffré qu'en mémoire le temps de l'appel et n'est ni renvoyé ni journalisé. Seul WhatsApp est vérifiable aujourd'hui (le fournisseur
 * e-mail attend le compte d'essai, C3). Une panne du fournisseur n'écrit RIEN (une intégration active ne devient pas « en erreur » pour une coupure).
 */
export type ValidationDeps = {
  readSecret: (organizationId: string, integrationId: string) => Promise<string | null>;
  validate: (input: { phoneNumberId: string; accessToken: string }) => Promise<WhatsAppValidation>;
  setValidation: (input: { organizationId: string; integrationId: string; ok: boolean; code: string | null; actorId: string }) => Promise<void>;
};

export const defaultValidationDeps: ValidationDeps = {
  readSecret: readIntegrationSecret,
  validate: (input) => createWhatsAppCloudClient().validate(input),
  async setValidation({ organizationId, integrationId, ok, code, actorId }) {
    const { error } = await createAdminClient().rpc("integration_set_validation", { p_org: organizationId, p_integration: integrationId, p_ok: ok, p_code: code, p_actor: actorId });
    if (!error) return;
    if (error.code === "PT404") throw new ServiceError("not_found");
    if (error.code === "P0001" || error.code === "22023") throw new ServiceError("validation_failed");
    throw new ServiceError("service_unavailable");
  },
};

export type ValidationResult = { status: "active" } | { status: "error"; code: string };

export async function validateIntegrationConnection(
  supabase: ServerSupabase,
  organizationId: string,
  integrationId: string,
  actorId: string,
  deps: ValidationDeps = defaultValidationDeps,
): Promise<ValidationResult> {
  const { data, error } = await supabase
    .from("integrations")
    .select("id, provider, status, external_account_id, has_secret")
    .eq("organization_id", organizationId)
    .eq("id", integrationId)
    .maybeSingle();
  if (error) throw new ServiceError("service_unavailable");
  if (!data) throw new ServiceError("not_found");
  const row = data as { provider: string; status: string; external_account_id: string; has_secret: boolean };
  if (row.provider !== "whatsapp" || !row.has_secret || !["pending", "active", "error"].includes(row.status)) throw new ServiceError("validation_failed");

  let token: string | null;
  try {
    token = await deps.readSecret(organizationId, integrationId);
  } catch {
    throw new ServiceError("service_unavailable");
  }
  if (token === null) throw new ServiceError("validation_failed");

  const outcome = await deps.validate({ phoneNumberId: row.external_account_id, accessToken: token });
  if (outcome.kind === "invalid" && outcome.code === "provider_unavailable") throw new ServiceError("service_unavailable");
  await deps.setValidation({ organizationId, integrationId, ok: outcome.kind === "valid", code: outcome.kind === "valid" ? null : outcome.code, actorId });
  return outcome.kind === "valid" ? { status: "active" } : { status: "error", code: outcome.code };
}
