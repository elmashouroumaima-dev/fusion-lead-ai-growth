import "server-only";
import type { WebhookStore } from "@fusion-leap/adapters";
import { createAdminClient } from "../supabase/admin";
import { ServiceError } from "./errors";

/**
 * Accès à la base des webhooks (J29), réservé au serveur : fonctions `webhook_*` exécutables par service_role seulement. Seul module de
 * l'application web qui les appelle. Les erreurs sont opaques ; une file saturée (`too_many_webhooks`) devient 503 (le fournisseur réessaie).
 */
export function createWebhookStore(): WebhookStore {
  const client = () => createAdminClient();
  return {
    async resolve(provider, account) {
      const { data, error } = await client().rpc("webhook_resolve_integration", { p_provider: provider, p_account: account });
      if (error) throw new ServiceError("service_unavailable");
      if (data === null || data === undefined) return null;
      const row = data as { organization_id?: unknown; integration_id?: unknown };
      if (typeof row.organization_id !== "string" || typeof row.integration_id !== "string") throw new ServiceError("internal_error");
      return { organizationId: row.organization_id, integrationId: row.integration_id };
    },
    async record(input) {
      const { data, error } = await client().rpc("webhook_record", {
        p_org: input.organizationId,
        p_integration: input.integrationId,
        p_provider: input.provider,
        p_event_id: input.externalEventId,
        p_payload: input.payload,
      });
      if (error) {
        // identifiant d'événement mal formé ou payload trop gros : requête invalide ; file saturée ou panne : le fournisseur réessaie
        if (error.code === "23514" || error.code === "22023" || error.code === "22P05" || error.code === "54000") throw new ServiceError("validation_failed");
        throw new ServiceError("service_unavailable");
      }
      const row = data as { event_id?: unknown; duplicate?: unknown } | null;
      if (!row || typeof row.event_id !== "string" || typeof row.duplicate !== "boolean") throw new ServiceError("internal_error");
      return { eventId: row.event_id, duplicate: row.duplicate };
    },
    async recordRejection(input) {
      // la trace est un effort : une panne (réponse en erreur ou exception) ne doit pas transformer un refus en erreur serveur
      try {
        await client().rpc("webhook_record_rejection", { p_org: input.organizationId, p_integration: input.integrationId, p_provider: input.provider });
      } catch {
        // ignorée : le refus 401 est renvoyé quand même
      }
    },
  };
}
