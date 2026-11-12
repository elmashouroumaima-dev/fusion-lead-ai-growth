import { createClient } from "@supabase/supabase-js";
import { readEmailEvent, type EmailEvent } from "@fusion-leap/adapters";
import { z } from "zod";
import { NonRetryableError } from "./errors";
import type { WebhookProcessor, WebhookProcessorInput } from "./webhooks";

/**
 * Traitement des événements e-mail du fournisseur (J32, spec §9.2) : l'événement a DÉJÀ été authentifié et normalisé par la route publique
 * (J29), puis enregistré ; ici il est appliqué par les fonctions SQL service_role. L'entreprise et l'intégration sont celles de la LIGNE du job /
 * de l'événement, jamais du contenu. Décisions : `delivered` n'arrive que par ici ; un rebond dur ajoute l'adresse aux suppressions SANS toucher
 * `do_not_contact` ; une plainte ajoute l'adresse aux suppressions ET pose `do_not_contact` ; un expéditeur inconnu ne crée JAMAIS de contact
 * (file `inbound_unmatched`). Aucun corps, adresse ni identifiant du fournisseur dans les journaux : seuls des codes courts sortent d'ici.
 */
export type StatusEvent = Extract<EmailEvent, { kind: "delivered" | "bounced" | "complaint" }>;
export type InboundEvent = Extract<EmailEvent, { kind: "inbound" }>;

export type StatusResult = { outcome: "applied" | "ignored"; reason?: string };
export type InboundResult = { outcome: "recorded" | "duplicate" | "unmatched" | "dropped"; reason?: string };

export interface EmailEventGateway {
  applyStatus(organizationId: string, integrationId: string, event: StatusEvent): Promise<StatusResult>;
  applyInbound(organizationId: string, integrationId: string, event: InboundEvent): Promise<InboundResult>;
}

export class EmailGatewayError extends Error {
  constructor(operation: string) {
    super(`email_${operation}_failed`);
    this.name = "EmailGatewayError";
  }
}

export function createEmailWebhookProcessor(gateway: EmailEventGateway): WebhookProcessor {
  return {
    provider: "email",
    async process(input: WebhookProcessorInput): Promise<"processed" | "ignored"> {
      const event = readEmailEvent(input.payload);
      // la forme conservée est celle que NOUS avons écrite : autre chose = base altérée, jamais rejouable
      if (event === null) throw new NonRetryableError("invalid_event");
      switch (event.kind) {
        case "ignored":
          return "ignored";
        case "inbound": {
          const result = await gateway.applyInbound(input.organizationId, input.integrationId, event);
          if (result.outcome === "dropped") {
            // file des cas ambigus pleine : échec VISIBLE et définitif (le message reste dans l'événement conservé, rejouable après le tri) ;
            // trop de messages en attente du même expéditeur : ignoré
            if (result.reason === "queue_full") throw new NonRetryableError("unmatched_queue_full");
            return "ignored";
          }
          return "processed";
        }
        case "delivered":
        case "bounced":
        case "complaint": {
          const result = await gateway.applyStatus(input.organizationId, input.integrationId, event);
          return result.outcome === "applied" ? "processed" : "ignored";
        }
      }
    },
  };
}

const statusSchema = z.object({ outcome: z.enum(["applied", "ignored"]), reason: z.string().max(40).optional() });
const inboundSchema = z.object({ outcome: z.enum(["recorded", "duplicate", "unmatched", "dropped"]), reason: z.string().max(40).optional() });

export type EmailEnv = { SUPABASE_URL: string; SUPABASE_SECRET_KEY: string };

/** Les erreurs de transport ne transportent ni URL, ni clé, ni message SQL, ni contenu d'e-mail. */
export function createSupabaseEmailEventGateway(env: EmailEnv): EmailEventGateway {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    async applyStatus(organizationId, integrationId, event) {
      const { data, error } = await client.rpc("email_status_apply", {
        p_org: organizationId,
        p_integration: integrationId,
        p_event: event.kind,
        p_hard: event.kind === "bounced" ? event.hard : false,
        p_provider_message_id: event.providerMessageId,
        p_ref: event.ref,
        p_event_at: event.at,
      });
      // l'envoi est encore en cours côté base : le job est rejoué (réessayable)
      if (error) throw new EmailGatewayError(error.message === "retry_later" ? "retry_later" : "status");
      const parsed = statusSchema.safeParse(data);
      if (!parsed.success) throw new EmailGatewayError("status");
      return parsed.data.reason === undefined ? { outcome: parsed.data.outcome } : { outcome: parsed.data.outcome, reason: parsed.data.reason };
    },
    async applyInbound(organizationId, integrationId, event) {
      const { data, error } = await client.rpc("email_inbound_apply", {
        p_org: organizationId,
        p_integration: integrationId,
        p_provider_message_id: event.providerMessageId,
        p_recipients: event.recipients,
        p_from: event.from,
        p_subject: event.subject,
        p_body: event.body,
        p_received_at: event.at,
        p_verified: event.spfPass,
        p_spam: event.spam,
      });
      if (error) throw new EmailGatewayError("inbound");
      const parsed = inboundSchema.safeParse(data);
      if (!parsed.success) throw new EmailGatewayError("inbound");
      return parsed.data.reason === undefined ? { outcome: parsed.data.outcome } : { outcome: parsed.data.outcome, reason: parsed.data.reason };
    },
  };
}
