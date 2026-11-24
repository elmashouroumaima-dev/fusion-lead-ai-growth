import "server-only";
import { createKapsoClient, createPostmarkValidator, createResendValidator, createWhatsAppCloudClient, type PostmarkValidation, type WhatsAppValidation } from "@fusion-leap/adapters";
import { createAdminClient } from "../supabase/admin";
import type { ServerSupabase } from "../tenant/identity";
import { ServiceError } from "./errors";
import { readIntegrationSecretWithId } from "./integration-secrets";

/**
 * Vérification d'une connexion (J34, spec §9.3) : le serveur essaie le jeton de l'intégration auprès du fournisseur puis enregistre le résultat par la
 * fonction `integration_set_validation` (service_role seulement : un utilisateur ne peut jamais déclarer une intégration « active »). L'entreprise
 * est celle du contexte vérifié ; l'intégration est relue AVEC LE CLIENT DE L'UTILISATEUR (RLS : owner et admin de cette entreprise), le jeton
 * n'est déchiffré qu'en mémoire le temps de l'appel et n'est ni renvoyé ni journalisé. Seul WhatsApp est vérifiable aujourd'hui (le fournisseur
 * e-mail attend le compte d'essai, C3). Une panne du fournisseur n'écrit RIEN (une intégration active ne devient pas « en erreur » pour une coupure).
 */
export type ValidationDeps = {
  /** Le jeton ET l'identifiant du secret lu : le résultat de la vérification n'est valable que pour CE secret (S-08). */
  readSecret: (organizationId: string, integrationId: string) => Promise<{ token: string; secretId: string } | null>;
  validate: (input: { phoneNumberId: string; accessToken: string }) => Promise<WhatsAppValidation>;
  validateEmail: (input: { serverToken: string }) => Promise<PostmarkValidation>;
  /** Clé d'API d'une intégration e-mail Resend (ADR 008). */
  validateResend: (input: { apiKey: string }) => Promise<PostmarkValidation>;
  /** Clé d'API d'une intégration WhatsApp de passerelle Kapso (ADR 017). */
  validateKapso: (input: { phoneNumberId: string; accessToken: string }) => Promise<WhatsAppValidation>;
  setValidation: (input: { organizationId: string; integrationId: string; ok: boolean; code: string | null; actorId: string; secretId: string }) => Promise<void>;
};

export const defaultValidationDeps: ValidationDeps = {
  readSecret: readIntegrationSecretWithId,
  validate: (input) => createWhatsAppCloudClient().validate(input),
  validateEmail: (input) => createPostmarkValidator().validate(input),
  validateResend: (input) => createResendValidator().validate(input),
  validateKapso: (input) => createKapsoClient().validate(input),
  async setValidation({ organizationId, integrationId, ok, code, actorId, secretId }) {
    const { error } = await createAdminClient().rpc("integration_set_validation", { p_org: organizationId, p_integration: integrationId, p_ok: ok, p_code: code, p_actor: actorId, p_secret_id: secretId });
    if (!error) return;
    if (error.code === "PT404") throw new ServiceError("not_found");
    // le jeton a été remplacé pendant l'appel au fournisseur : ce résultat ne vaut pas pour le nouveau jeton (S-08) ; l'utilisateur relance la vérification
    if (error.code === "P0001" && error.message === "stale_validation") throw new ServiceError("conflict");
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
    .select("id, provider, status, external_account_id, gateway, has_secret")
    .eq("organization_id", organizationId)
    .eq("id", integrationId)
    .maybeSingle();
  if (error) throw new ServiceError("service_unavailable");
  if (!data) throw new ServiceError("not_found");
  const row = data as { provider: string; status: string; external_account_id: string; gateway?: string; has_secret: boolean };
  if ((row.provider !== "whatsapp" && row.provider !== "email") || !row.has_secret || !["pending", "active", "error"].includes(row.status)) throw new ServiceError("validation_failed");

  let secret: { token: string; secretId: string } | null;
  try {
    secret = await deps.readSecret(organizationId, integrationId);
  } catch {
    throw new ServiceError("service_unavailable");
  }
  if (secret === null) throw new ServiceError("validation_failed");
  const token = secret.token;

  const outcome =
    row.provider === "email"
      ? row.gateway === "resend"
        ? await deps.validateResend({ apiKey: token })
        : await deps.validateEmail({ serverToken: token })
      : row.gateway === "kapso"
        ? await deps.validateKapso({ phoneNumberId: row.external_account_id, accessToken: token })
        : await deps.validate({ phoneNumberId: row.external_account_id, accessToken: token });
  if (outcome.kind === "invalid" && outcome.code === "provider_unavailable") throw new ServiceError("service_unavailable");
  await deps.setValidation({ organizationId, integrationId, ok: outcome.kind === "valid", code: outcome.kind === "valid" ? null : outcome.code, actorId, secretId: secret.secretId });
  return outcome.kind === "valid" ? { status: "active" } : { status: "error", code: outcome.code };
}
