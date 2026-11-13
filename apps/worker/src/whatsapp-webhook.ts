import { createClient } from "@supabase/supabase-js";
import { readWhatsAppPayload, type WhatsAppEvent } from "@fusion-leap/adapters";
import { z } from "zod";
import { NonRetryableError } from "./errors";
import type { WebhookProcessor, WebhookProcessorInput } from "./webhooks";

/**
 * Traitement des événements WhatsApp de Meta (J35, spec §9.3) : l'événement a DÉJÀ été authentifié (signature) et normalisé par la route publique
 * (J29 et J34), puis enregistré ; ici chaque message reçu et chaque statut est appliqué par les fonctions SQL service_role. L'entreprise et
 * l'intégration sont celles de la LIGNE du job / de l'événement, jamais du contenu. Un expéditeur inconnu ne crée JAMAIS de contact (file
 * `inbound_unmatched`). Rejouer un événement est sans danger (déduplication par identifiant de message chez Meta, statuts qui n'avancent que dans
 * l'ordre). Aucun texte de message, numéro ni identifiant dans les journaux : seuls des codes courts sortent d'ici.
 */
export type MessageEvent = Extract<WhatsAppEvent, { kind: "message" }>;
export type StatusEvent = Extract<WhatsAppEvent, { kind: "status" }>;

export type StatusResult = { outcome: "applied" | "ignored"; reason?: string };
export type InboundResult = { outcome: "recorded" | "duplicate" | "unmatched" | "dropped"; reason?: string };

export interface WhatsAppEventGateway {
  applyMessage(organizationId: string, integrationId: string, event: MessageEvent): Promise<InboundResult>;
  applyStatus(organizationId: string, integrationId: string, event: StatusEvent): Promise<StatusResult>;
}

export class WhatsAppGatewayError extends Error {
  constructor(operation: string) {
    super(`whatsapp_${operation}_failed`);
    this.name = "WhatsAppGatewayError";
  }
}

/** Intégration disparue (déconnectée depuis la réception : PT404) ou valeur refusée (22023) : jamais rejouable. Le reste est réessayé. Aucun détail SQL n'est transporté. */
function gatewayError(operation: string, code: string | undefined): Error {
  if (code === "PT404") return new NonRetryableError("integration_gone");
  if (code === "22023") return new NonRetryableError("invalid_event");
  return new WhatsAppGatewayError(operation);
}

export function createWhatsAppWebhookProcessor(gateway: WhatsAppEventGateway): WebhookProcessor {
  return {
    provider: "whatsapp",
    async process(input: WebhookProcessorInput): Promise<"processed" | "ignored"> {
      const payload = readWhatsAppPayload(input.payload);
      // la forme conservée est celle que NOUS avons écrite : autre chose = base altérée, jamais rejouable
      if (payload === null) throw new NonRetryableError("invalid_event");
      let processed = false;
      let queueFull = false;
      for (const event of payload.events) {
        if (event.kind === "message") {
          const result = await gateway.applyMessage(input.organizationId, input.integrationId, event);
          // file des cas ambigus pleine : échec VISIBLE et définitif à la fin (les autres événements de la requête sont traités d'abord) ; le message reste
          // dans l'événement conservé, rejouable après le tri. Trop de messages en attente du même expéditeur : ignoré.
          if (result.outcome === "dropped") {
            if (result.reason === "queue_full") queueFull = true;
            continue;
          }
          processed = true;
        } else {
          const result = await gateway.applyStatus(input.organizationId, input.integrationId, event);
          if (result.outcome === "applied") processed = true;
        }
      }
      if (queueFull) throw new NonRetryableError("unmatched_queue_full");
      return processed ? "processed" : "ignored";
    },
  };
}

const statusSchema = z.object({ outcome: z.enum(["applied", "ignored"]), reason: z.string().max(40).optional() });
const inboundSchema = z.object({ outcome: z.enum(["recorded", "duplicate", "unmatched", "dropped"]), reason: z.string().max(40).optional() });

export type WhatsAppEnv = { SUPABASE_URL: string; SUPABASE_SECRET_KEY: string };

/** Les erreurs de transport ne transportent ni URL, ni clé, ni message SQL, ni contenu de message. */
export function createSupabaseWhatsAppEventGateway(env: WhatsAppEnv): WhatsAppEventGateway {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  return {
    async applyMessage(organizationId, integrationId, event) {
      const { data, error } = await client.rpc("whatsapp_inbound_apply", {
        p_org: organizationId,
        p_integration: integrationId,
        p_provider_message_id: event.id,
        p_from: event.from,
        p_type: event.type,
        p_body: event.text,
        p_received_at: event.at,
      });
      if (error) throw gatewayError("inbound", error.code);
      const parsed = inboundSchema.safeParse(data);
      if (!parsed.success) throw new WhatsAppGatewayError("inbound");
      return parsed.data.reason === undefined ? { outcome: parsed.data.outcome } : { outcome: parsed.data.outcome, reason: parsed.data.reason };
    },
    async applyStatus(organizationId, integrationId, event) {
      const { data, error } = await client.rpc("whatsapp_status_apply", {
        p_org: organizationId,
        p_integration: integrationId,
        p_provider_message_id: event.id,
        p_status: event.status,
        p_error_code: event.errorCode,
        p_event_at: event.at,
      });
      if (error) throw gatewayError("status", error.code);
      const parsed = statusSchema.safeParse(data);
      if (!parsed.success) throw new WhatsAppGatewayError("status");
      return parsed.data.reason === undefined ? { outcome: parsed.data.outcome } : { outcome: parsed.data.outcome, reason: parsed.data.reason };
    },
  };
}
