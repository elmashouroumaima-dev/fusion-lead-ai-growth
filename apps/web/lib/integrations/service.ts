import { sealOrganizationSecret } from "@fusion-leap/adapters";
import {
  channelRowSchema,
  integrationRowSchema,
  type ChannelRow,
  type CreateChannelInput,
  type CreateProviderIntegrationInput,
  type DisconnectIntegrationInput,
  type IntegrationRow,
  type ReplaceIntegrationSecretInput,
  type ReplaceWebhookSecretInput,
  type UpdateChannelInput,
} from "@fusion-leap/domain";
import { mapLeadsDbError } from "../leads/map-error";
import type { ServiceErrorCode } from "../service/errors";
import { getKeyRing } from "../smtp/secrets";
import type { ServerSupabase } from "../tenant/identity";

/**
 * Intégrations à secret et canaux (J28, ADR 004 et 007). Tout passe par le client serveur de l'UTILISATEUR (colonnes lisibles par
 * la RLS : jamais `secret_ref` ; fonctions SQL qui revérifient le rôle owner / admin) ; aucune `service_role` ici. Le jeton est chiffré
 * dans ce module (AES-256-GCM, AAD liée à l'entreprise) AVANT l'appel : la base ne reçoit que le chiffré, et RIEN de ce module ne renvoie
 * ni ne journalise le jeton. L'entreprise vient du CONTEXTE VÉRIFIÉ, jamais du corps.
 */
export type IntegrationsResult<T> = { ok: true; value: T } | { ok: false; code: ServiceErrorCode };
const fail = (code: ServiceErrorCode): { ok: false; code: ServiceErrorCode } => ({ ok: false, code });

const INTEGRATION_COLUMNS =
  "id, organization_id, provider, status, external_account_id, scopes, has_secret, has_webhook_secret, last_sync_at, last_sync_finished_at, last_error, created_at, updated_at";
const CHANNEL_COLUMNS = "id, organization_id, type, integration_id, sender_identity, status, project_scope, send_paused, created_at, updated_at";

export type IntegrationView = { integration: IntegrationRow; channels: ChannelRow[] };

/** Le chiffrement est-il configuré (clé maître dans l'environnement serveur) ? Sans lui, aucun secret ne peut être enregistré. */
export const isEncryptionConfigured = (): boolean => getKeyRing() !== null;

/** Intégrations de l'entreprise (20 au plus) avec leurs canaux, sans aucune colonne de secret. */
export async function listIntegrationViews(supabase: ServerSupabase, organizationId: string): Promise<IntegrationView[]> {
  const integrations = await supabase
    .from("integrations")
    .select(INTEGRATION_COLUMNS)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (integrations.error || !Array.isArray(integrations.data)) throw new Error("integrations_lookup_failed");
  const channels = await supabase
    .from("channels")
    .select(CHANNEL_COLUMNS)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (channels.error || !Array.isArray(channels.data)) throw new Error("channels_lookup_failed");
  const channelRows = channels.data.map((row: unknown) => {
    const parsed = channelRowSchema.safeParse(row);
    if (!parsed.success) throw new Error("rows_unreadable");
    return parsed.data;
  });
  return integrations.data.map((row: unknown) => {
    const parsed = integrationRowSchema.safeParse(row);
    if (!parsed.success) throw new Error("rows_unreadable");
    return { integration: parsed.data, channels: channelRows.filter((channel) => channel.integration_id === parsed.data.id) };
  });
}

export async function createProviderIntegration(
  supabase: ServerSupabase,
  organizationId: string,
  input: CreateProviderIntegrationInput,
): Promise<IntegrationsResult<{ id: string }>> {
  const keyRing = getKeyRing();
  if (!keyRing) return fail("service_unavailable");
  let sealed;
  try {
    sealed = sealOrganizationSecret({ organizationId, plaintext: input.secret, keyRing });
  } catch {
    return fail("internal_error");
  }
  const { data, error } = await supabase.rpc("create_provider_integration", {
    p_org: organizationId,
    p_provider: input.provider,
    p_account: input.external_account_id,
    p_scopes: input.scopes,
    p_secret_id: sealed.secretId,
    p_ciphertext: sealed.ciphertext,
    p_nonce: sealed.nonce,
    p_key_version: sealed.keyVersion,
  });
  if (error) return fail(mapLeadsDbError(error));
  return typeof data === "string" ? { ok: true, value: { id: data } } : fail("internal_error");
}

/** Remplace le jeton d'une intégration (rotation : le nouveau est écrit, l'ancien supprimé dans la même transaction). */
export async function replaceIntegrationSecret(
  supabase: ServerSupabase,
  organizationId: string,
  input: ReplaceIntegrationSecretInput,
): Promise<IntegrationsResult<true>> {
  const keyRing = getKeyRing();
  if (!keyRing) return fail("service_unavailable");
  let sealed;
  try {
    sealed = sealOrganizationSecret({ organizationId, plaintext: input.secret, keyRing });
  } catch {
    return fail("internal_error");
  }
  const { error } = await supabase.rpc("set_integration_secret", {
    p_org: organizationId,
    p_integration: input.integration_id,
    p_secret_id: sealed.secretId,
    p_ciphertext: sealed.ciphertext,
    p_nonce: sealed.nonce,
    p_key_version: sealed.keyVersion,
  });
  return error ? fail(mapLeadsDbError(error)) : { ok: true, value: true };
}

/**
 * Enregistre ou remplace le secret de WEBHOOK d'une intégration (J32) : le mot de passe que le fournisseur envoie en Basic Auth. Chiffré ici
 * (AES-256-GCM, AAD liée à l'entreprise) avant l'appel ; la base ne reçoit que le chiffré, la réponse ne le renvoie jamais.
 */
export async function replaceWebhookSecret(
  supabase: ServerSupabase,
  organizationId: string,
  input: ReplaceWebhookSecretInput,
): Promise<IntegrationsResult<true>> {
  const keyRing = getKeyRing();
  if (!keyRing) return fail("service_unavailable");
  let sealed;
  try {
    sealed = sealOrganizationSecret({ organizationId, plaintext: input.secret, keyRing });
  } catch {
    return fail("internal_error");
  }
  const { error } = await supabase.rpc("set_integration_webhook_secret", {
    p_org: organizationId,
    p_integration: input.integration_id,
    p_secret_id: sealed.secretId,
    p_ciphertext: sealed.ciphertext,
    p_nonce: sealed.nonce,
    p_key_version: sealed.keyVersion,
  });
  return error ? fail(mapLeadsDbError(error)) : { ok: true, value: true };
}

/** Déconnecte : supprime le secret et met les canaux de l'intégration en pause. */
export async function disconnectIntegration(
  supabase: ServerSupabase,
  organizationId: string,
  input: DisconnectIntegrationInput,
): Promise<IntegrationsResult<true>> {
  const { error } = await supabase.rpc("disconnect_integration", { p_org: organizationId, p_integration: input.integration_id });
  return error ? fail(mapLeadsDbError(error)) : { ok: true, value: true };
}

export async function createChannel(supabase: ServerSupabase, organizationId: string, input: CreateChannelInput): Promise<IntegrationsResult<{ id: string }>> {
  const { data, error } = await supabase.rpc("create_channel", {
    p_org: organizationId,
    p_integration: input.integration_id,
    p_type: input.type,
    p_sender: input.sender_identity,
    p_scope: input.project_scope,
  });
  if (error) return fail(mapLeadsDbError(error));
  return typeof data === "string" ? { ok: true, value: { id: data } } : fail("internal_error");
}

export async function updateChannel(supabase: ServerSupabase, organizationId: string, input: UpdateChannelInput): Promise<IntegrationsResult<true>> {
  const { error } = await supabase.rpc("update_channel", {
    p_org: organizationId,
    p_id: input.channel_id,
    p_scope: input.project_scope ?? null,
    p_paused: input.send_paused ?? null,
  });
  return error ? fail(mapLeadsDbError(error)) : { ok: true, value: true };
}
