import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

/**
 * Accès du worker au traitement différé des webhooks (J29). Une seule implémentation de production (RPC Supabase, clé service_role,
 * fonctions SQL réservées à ce rôle) ; les tests injectent une version en mémoire. L'entreprise est TOUJOURS celle de la ligne du job,
 * jamais celle du payload. Les processeurs par fournisseur (e-mail J32, WhatsApp J35) s'enregistrent dans `WebhookProcessors`.
 */
export type WebhookStart =
  | { status: "running"; provider: string; integrationId: string; payload: unknown }
  | { status: "missing" | "done" };

export type WebhookFinishStatus = "processed" | "ignored" | "failed";

export interface WebhookGateway {
  start(organizationId: string, eventId: string): Promise<WebhookStart>;
  finish(organizationId: string, eventId: string, status: WebhookFinishStatus, failureCode: string | null): Promise<void>;
}

export type WebhookProcessorInput = { organizationId: string; eventId: string; integrationId: string; payload: unknown };

/** Un processeur lit le payload d'UN fournisseur ; il renvoie `processed` ou `ignored` (événement sans effet : statut de lecture, etc.). */
export interface WebhookProcessor {
  readonly provider: string;
  process(input: WebhookProcessorInput): Promise<"processed" | "ignored">;
}

export type WebhookProcessors = ReadonlyMap<string, WebhookProcessor>;

export class WebhookGatewayError extends Error {
  constructor(operation: string) {
    super(`webhook_${operation}_failed`);
    this.name = "WebhookGatewayError";
  }
}

const startSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("running"), provider: z.string().min(1).max(20), integration_id: z.uuid(), payload: z.unknown() }),
  z.object({ status: z.literal("missing") }),
  z.object({ status: z.literal("done") }),
]);

export type WebhookEnv = { SUPABASE_URL: string; SUPABASE_SECRET_KEY: string };

/** Les erreurs de transport ne transportent ni URL, ni clé, ni message SQL, ni payload. */
export function createSupabaseWebhookGateway(env: WebhookEnv): WebhookGateway {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    async start(organizationId, eventId) {
      const { data, error } = await client.rpc("webhook_start", { p_org: organizationId, p_event: eventId });
      if (error) throw new WebhookGatewayError("start");
      const parsed = startSchema.safeParse(data);
      if (!parsed.success) throw new WebhookGatewayError("start");
      if (parsed.data.status !== "running") return { status: parsed.data.status };
      return { status: "running", provider: parsed.data.provider, integrationId: parsed.data.integration_id, payload: parsed.data.payload };
    },
    async finish(organizationId, eventId, status, failureCode) {
      const { error } = await client.rpc("webhook_finish", { p_org: organizationId, p_event: eventId, p_status: status, p_failure: failureCode });
      if (error) throw new WebhookGatewayError("finish");
    },
  };
}
