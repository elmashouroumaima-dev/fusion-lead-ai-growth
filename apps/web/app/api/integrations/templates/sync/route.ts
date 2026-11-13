import { syncTemplatesSchema } from "@fusion-leap/domain";
import { syncWhatsAppTemplates } from "../../../../../lib/service/template-sync";
import { withRoute } from "../../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/**
 * Synchroniser les modèles de message WhatsApp d'un canal (J36) : `POST /api/integrations/templates/sync` `{ integration_id, channel_id, waba_id }`.
 * Le serveur demande la liste à Meta avec le jeton de l'intégration et met à jour `message_templates` (nouvelle version quand les composants changent).
 * Réponse : `{ inserted, updated, unchanged, skipped }`. Owner et admin ; `Idempotency-Key` obligatoire ; limite « sensible » (l'appel sort vers un tiers).
 * Panne de Meta : 503 sans rien écrire ; jeton ou compte refusé : 400.
 */
export const POST = withRoute(
  {
    name: "integrations.templates.sync",
    auth: "tenant",
    rateLimit: "sensitive",
    idempotency: { mode: "required", storeResponse: true },
    permission: { action: "connect", resource: "integrations" },
    schema: syncTemplatesSchema,
  },
  async (ctx, input) => {
    const result = await syncWhatsAppTemplates(ctx.supabase, ctx.organizationId, { integrationId: input.integration_id, channelId: input.channel_id, wabaId: input.waba_id });
    return { status: 200, body: result };
  },
);
