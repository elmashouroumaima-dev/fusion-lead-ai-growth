import "server-only";
import { createWhatsAppTemplateClient, type TemplateList } from "@fusion-leap/adapters";
import { createAdminClient } from "../supabase/admin";
import type { ServerSupabase } from "../tenant/identity";
import { ServiceError } from "./errors";
import { readIntegrationSecret } from "./integration-secrets";

/**
 * Synchronisation des modèles de message WhatsApp d'un canal (J36, spec §9.3). Le serveur relit l'intégration et le canal AVEC LE CLIENT DE L'UTILISATEUR
 * (RLS : owner et admin de cette entreprise), déchiffre le jeton en mémoire, demande la liste à Meta (adresse fixe) puis écrit par `message_templates_sync`
 * (service_role seulement). L'entreprise est celle du contexte vérifié. Le jeton n'est ni renvoyé ni journalisé ; aucun texte de Meta n'est recopié.
 * Panne de Meta : 503 sans rien écrire. Résultat : `{ inserted, updated, unchanged, skipped }`.
 */
export type TemplateSyncDeps = {
  readSecret: (organizationId: string, integrationId: string) => Promise<string | null>;
  list: (input: { wabaId: string; accessToken: string }) => Promise<TemplateList>;
  sync: (input: { organizationId: string; channelId: string; items: unknown[] }) => Promise<{ inserted: number; updated: number; unchanged: number }>;
};

export const defaultTemplateSyncDeps: TemplateSyncDeps = {
  readSecret: readIntegrationSecret,
  list: (input) => createWhatsAppTemplateClient().list(input),
  async sync({ organizationId, channelId, items }) {
    const { data, error } = await createAdminClient().rpc("message_templates_sync", { p_org: organizationId, p_channel: channelId, p_items: items });
    if (error) {
      if (error.code === "PT404") throw new ServiceError("not_found");
      if (error.code === "22023" || error.code === "P0001") throw new ServiceError("validation_failed");
      throw new ServiceError("service_unavailable");
    }
    const row = data as { inserted?: unknown; updated?: unknown; unchanged?: unknown } | null;
    if (!row || typeof row.inserted !== "number" || typeof row.updated !== "number" || typeof row.unchanged !== "number") throw new ServiceError("internal_error");
    return { inserted: row.inserted, updated: row.updated, unchanged: row.unchanged };
  },
};

export type TemplateSyncResult = { inserted: number; updated: number; unchanged: number; skipped: number };

export async function syncWhatsAppTemplates(
  supabase: ServerSupabase,
  organizationId: string,
  input: { integrationId: string; channelId: string; wabaId: string },
  deps: TemplateSyncDeps = defaultTemplateSyncDeps,
): Promise<TemplateSyncResult> {
  const { data: integration, error: integrationError } = await supabase
    .from("integrations")
    .select("id, provider, status, has_secret")
    .eq("organization_id", organizationId)
    .eq("id", input.integrationId)
    .maybeSingle();
  if (integrationError) throw new ServiceError("service_unavailable");
  if (!integration) throw new ServiceError("not_found");
  const row = integration as { provider: string; status: string; has_secret: boolean };
  if (row.provider !== "whatsapp" || !row.has_secret || !["pending", "active", "error"].includes(row.status)) throw new ServiceError("validation_failed");

  // le canal doit appartenir à CETTE intégration, dans cette entreprise
  const { data: channel, error: channelError } = await supabase
    .from("channels")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("integration_id", input.integrationId)
    .eq("id", input.channelId)
    .maybeSingle();
  if (channelError) throw new ServiceError("service_unavailable");
  if (!channel) throw new ServiceError("not_found");

  let token: string | null;
  try {
    token = await deps.readSecret(organizationId, input.integrationId);
  } catch {
    throw new ServiceError("service_unavailable");
  }
  if (token === null) throw new ServiceError("validation_failed");

  const listed = await deps.list({ wabaId: input.wabaId, accessToken: token });
  if (listed.kind === "error") {
    // jeton ou compte refusé : requête invalide pour l'appelant ; panne ou réponse illisible : réessayer plus tard
    throw new ServiceError(listed.code === "provider_auth" || listed.code === "provider_account" ? "validation_failed" : "service_unavailable");
  }
  const counts = await deps.sync({ organizationId, channelId: input.channelId, items: listed.items });
  return { ...counts, skipped: listed.skipped };
}
