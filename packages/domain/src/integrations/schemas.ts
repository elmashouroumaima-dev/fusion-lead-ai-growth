import { z } from "zod";
import { CHANNEL_TYPES } from "../contacts";
import { uuidSchema } from "../tenant/schemas";

/**
 * Intégrations à secret et canaux (J28, spec §7 et §11, ADR 004 et 007). Le secret (jeton, clé d'API) n'est jamais renvoyé : les lignes
 * lisibles ne portent que `has_secret`. Les schémas d'entrée sont stricts et refusent un `organization_id` (l'entreprise vient du contexte vérifié).
 */
export const SECRET_PROVIDERS = ["email", "whatsapp"] as const;
export type SecretProvider = (typeof SECRET_PROVIDERS)[number];

export const INTEGRATION_PROVIDERS = ["csv", "internal", "email", "whatsapp"] as const;
export const INTEGRATION_STATUSES = ["pending", "active", "error", "disconnected", "disabled"] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const CHANNEL_STATUSES = ["pending", "active", "paused", "disconnected"] as const;

/** Plafond d'un secret en OCTETS UTF-8 : le chiffré (base64) reste sous la limite de 8192 caractères de `private.secrets`. */
export const INTEGRATION_SECRET_MAX_BYTES = 4096;

/** Un secret : 8 caractères au moins, 4096 octets UTF-8 au plus, sans caractère de contrôle (tabulation et retours à la ligne permis : clés JSON ou PEM). */
export const integrationSecretSchema = z
  .string()
  .min(8)
  // eslint-disable-next-line no-control-regex -- la liste des caractères de contrôle refusés est volontaire
  .regex(/^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+$/)
  .refine((value) => new TextEncoder().encode(value).length <= INTEGRATION_SECRET_MAX_BYTES);

/** Identité d'un canal : une adresse e-mail, ou un numéro WhatsApp au format E.164. La preuve de propriété vient de la validation par le fournisseur. */
const EMAIL_SENDER = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164_SENDER = /^\+[1-9][0-9]{6,14}$/;

const accountSchema = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/);
const scopeSchema = z.string().regex(/^[A-Za-z0-9._:/-]{1,100}$/);

export const createProviderIntegrationSchema = z
  .object({
    provider: z.enum(SECRET_PROVIDERS),
    external_account_id: accountSchema,
    scopes: z.array(scopeSchema).max(50).default([]),
    secret: integrationSecretSchema,
  })
  .strict()
  .refine((value) => new Set(value.scopes).size === value.scopes.length, { path: ["scopes"] });
export type CreateProviderIntegrationInput = z.infer<typeof createProviderIntegrationSchema>;

/**
 * Secret de webhook (J32) : mot de passe du Basic Auth que le fournisseur envoie à chaque événement. 32 à 200 caractères ASCII imprimables sans
 * espace (il se colle dans l'adresse du webhook du fournisseur). Distinct du jeton d'envoi. Jamais renvoyé, jamais journalisé.
 */
export const integrationWebhookSecretSchema = z.string().regex(/^[!-~]{32,200}$/);

export const replaceWebhookSecretSchema = z.object({ integration_id: uuidSchema, secret: integrationWebhookSecretSchema }).strict();
export type ReplaceWebhookSecretInput = z.infer<typeof replaceWebhookSecretSchema>;

export const replaceIntegrationSecretSchema = z.object({ integration_id: uuidSchema, secret: integrationSecretSchema }).strict();
export type ReplaceIntegrationSecretInput = z.infer<typeof replaceIntegrationSecretSchema>;

export const disconnectIntegrationSchema = z.object({ integration_id: uuidSchema }).strict();
export type DisconnectIntegrationInput = z.infer<typeof disconnectIntegrationSchema>;

export const createChannelSchema = z
  .object({
    integration_id: uuidSchema,
    type: z.enum(CHANNEL_TYPES),
    sender_identity: z.string().min(1).max(200),
    project_scope: z.array(uuidSchema).max(100).default([]),
  })
  .strict()
  .refine((value) => (value.type === "email" ? EMAIL_SENDER.test(value.sender_identity) : E164_SENDER.test(value.sender_identity)), { path: ["sender_identity"] });
export type CreateChannelInput = z.infer<typeof createChannelSchema>;

export const updateChannelSchema = z
  .object({ channel_id: uuidSchema, project_scope: z.array(uuidSchema).max(100).optional(), send_paused: z.boolean().optional() })
  .strict()
  .refine((value) => value.project_scope !== undefined || value.send_paused !== undefined, { path: ["send_paused"] });
export type UpdateChannelInput = z.infer<typeof updateChannelSchema>;

/** Ligne lisible d'une intégration : aucune colonne de secret. */
export const integrationRowSchema = z.object({
  id: uuidSchema,
  organization_id: uuidSchema,
  provider: z.enum(INTEGRATION_PROVIDERS),
  status: z.enum(INTEGRATION_STATUSES),
  external_account_id: z.string(),
  scopes: z.array(z.string()),
  has_secret: z.boolean(),
  has_webhook_secret: z.boolean().default(false),
  last_sync_at: z.string().nullable(),
  last_sync_finished_at: z.string().nullable(),
  last_error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type IntegrationRow = z.infer<typeof integrationRowSchema>;

export const channelRowSchema = z.object({
  id: uuidSchema,
  organization_id: uuidSchema,
  type: z.enum(CHANNEL_TYPES),
  integration_id: uuidSchema,
  sender_identity: z.string(),
  status: z.enum(CHANNEL_STATUSES),
  project_scope: z.array(uuidSchema),
  send_paused: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ChannelRow = z.infer<typeof channelRowSchema>;
