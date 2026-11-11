import { createClient } from "@supabase/supabase-js";
import { createKeyRing, openOrganizationSecret } from "@fusion-leap/adapters";
import { z } from "zod";

/**
 * Accès du worker à l'envoi sortant (J31). Une seule implémentation de production (RPC Supabase, clé service_role, fonctions SQL réservées à
 * ce rôle) ; les tests injectent une version en mémoire. L'entreprise est TOUJOURS celle de la ligne du job.
 * `claim` relit tout l'état utile aux contrôles dans UNE transaction verrouillée ET pose l'unique tentative d'appel au fournisseur.
 */
export type SendClaim =
  | { status: "missing" }
  | { status: "not_queued" }
  | { status: "in_progress" }
  | { status: "ambiguous" }
  | {
      status: "claimed";
      message: { body: string; approved: boolean; purpose: string | null; approverValid: boolean; approvalAgeSeconds: number | null; recipientUnchanged: boolean };
      contact: { email: string | null; doNotContact: boolean };
      channel: { type: string; status: string; sendPaused: boolean; sender: string; integrationId: string; integrationStatus: string };
      organizationActive: boolean;
      organizationSendPaused: boolean;
      consent: boolean;
      suppressed: boolean;
      sentLastHour: number;
    };

export interface SendGateway {
  claim(organizationId: string, messageId: string): Promise<SendClaim>;
  markAccepted(organizationId: string, messageId: string, providerMessageId: string): Promise<void>;
  markFailed(organizationId: string, messageId: string, code: string): Promise<void>;
  /** Le fournisseur a répondu qu'il n'a PAS accepté : un nouvel essai est permis. */
  releaseClaim(organizationId: string, messageId: string): Promise<void>;
}

/** Jeton du fournisseur d'une intégration (déchiffré en mémoire, le temps d'un appel) ; `null` si l'intégration n'a pas de secret. */
export type SecretReader = (organizationId: string, integrationId: string) => Promise<string | null>;

export class SendGatewayError extends Error {
  constructor(operation: string) {
    super(`send_${operation}_failed`);
    this.name = "SendGatewayError";
  }
}

const claimSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("missing") }),
  z.object({ status: z.literal("not_queued") }),
  z.object({ status: z.literal("in_progress") }),
  z.object({ status: z.literal("ambiguous") }),
  z.object({
    status: z.literal("claimed"),
    message: z.object({
      body: z.string().min(1), approved: z.boolean(), purpose: z.string().nullable(),
      approver_valid: z.boolean(), approval_age_seconds: z.number().int().nullable(), recipient_unchanged: z.boolean(),
    }),
    contact: z.object({ email: z.string().nullable(), do_not_contact: z.boolean() }),
    channel: z.object({
      type: z.string(), status: z.string(), send_paused: z.boolean(), sender: z.string(), integration_id: z.uuid(), integration_status: z.string().nullable(),
    }),
    organization_active: z.boolean(),
    organization_send_paused: z.boolean(),
    consent: z.boolean(),
    suppressed: z.boolean(),
    sent_last_hour: z.number().int().nonnegative(),
  }),
]);

export type SendEnv = { SUPABASE_URL: string; SUPABASE_SECRET_KEY: string; SECRETS_MASTER_KEY?: string | undefined; SECRETS_KEY_VERSION?: number | undefined };

function adminClient(env: SendEnv) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

/** Les erreurs de transport ne transportent ni URL, ni clé, ni message SQL, ni corps de message. */
export function createSupabaseSendGateway(env: SendEnv): SendGateway {
  const client = adminClient(env);
  return {
    async claim(organizationId, messageId) {
      const { data, error } = await client.rpc("message_send_claim", { p_org: organizationId, p_message: messageId });
      if (error) throw new SendGatewayError("claim");
      const parsed = claimSchema.safeParse(data);
      if (!parsed.success) throw new SendGatewayError("claim");
      const row = parsed.data;
      if (row.status === "missing") return { status: "missing" };
      if (row.status === "not_queued") return { status: "not_queued" };
      if (row.status === "in_progress") return { status: "in_progress" };
      if (row.status === "ambiguous") return { status: "ambiguous" };
      return {
        status: "claimed",
        message: {
          body: row.message.body, approved: row.message.approved, purpose: row.message.purpose, approverValid: row.message.approver_valid,
          approvalAgeSeconds: row.message.approval_age_seconds, recipientUnchanged: row.message.recipient_unchanged,
        },
        contact: { email: row.contact.email, doNotContact: row.contact.do_not_contact },
        channel: {
          type: row.channel.type, status: row.channel.status, sendPaused: row.channel.send_paused, sender: row.channel.sender,
          integrationId: row.channel.integration_id, integrationStatus: row.channel.integration_status ?? "unknown",
        },
        organizationActive: row.organization_active,
        organizationSendPaused: row.organization_send_paused,
        consent: row.consent,
        suppressed: row.suppressed,
        sentLastHour: row.sent_last_hour,
      };
    },
    async markAccepted(organizationId, messageId, providerMessageId) {
      const { error } = await client.rpc("message_mark_accepted", { p_org: organizationId, p_message: messageId, p_provider_message_id: providerMessageId });
      if (error) throw new SendGatewayError("accept");
    },
    async markFailed(organizationId, messageId, code) {
      const { error } = await client.rpc("message_mark_failed", { p_org: organizationId, p_message: messageId, p_code: code });
      if (error) throw new SendGatewayError("fail");
    },
    async releaseClaim(organizationId, messageId) {
      const { error } = await client.rpc("message_release_claim", { p_org: organizationId, p_message: messageId });
      if (error) throw new SendGatewayError("release");
    },
  };
}

/** Lecture du jeton : `get_integration_secret` (service_role) puis déchiffrement en mémoire. Toute erreur est opaque (aucun détail du chiffrement). */
export function createSupabaseSecretReader(env: SendEnv): SecretReader {
  const client = adminClient(env);
  const keyRing = env.SECRETS_MASTER_KEY
    ? createKeyRing(env.SECRETS_KEY_VERSION ?? 1, { [env.SECRETS_KEY_VERSION ?? 1]: env.SECRETS_MASTER_KEY })
    : null;
  return async (organizationId, integrationId) => {
    if (!keyRing) throw new Error("secrets_unavailable");
    const { data, error } = await client.rpc("get_integration_secret", { p_org: organizationId, p_integration: integrationId });
    if (error) throw new Error("secret_lookup_failed");
    if (data === null || data === undefined) return null;
    const row = data as { secret_id?: unknown; ciphertext?: unknown; nonce?: unknown; key_version?: unknown };
    if (typeof row.secret_id !== "string" || typeof row.ciphertext !== "string" || typeof row.nonce !== "string" || typeof row.key_version !== "number") {
      throw new Error("secret_unreadable");
    }
    try {
      return openOrganizationSecret({
        organizationId,
        stored: { secretId: row.secret_id, ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.key_version },
        keyRing,
      });
    } catch {
      throw new Error("secret_unreadable");
    }
  };
}
