import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

/**
 * Accès du worker à la synchro CRM (J25). Une seule implémentation de production (RPC Supabase et Storage avec la clé service_role,
 * fonctions SQL réservées à ce rôle) ; les tests injectent une version en mémoire. L'entreprise est TOUJOURS celle de la ligne du job.
 */
export type CrmSyncStart =
  | { status: "running"; path: string; provider: string; /** identifiant externe PROPRE à l'intégration (`csv:<id>`) */ source: string; lastSyncAt: Date | null; lastSyncFinishedAt: Date | null; startedAt: Date; mappings: unknown }
  | { status: "missing" | "file_missing" };

export type CrmFound =
  | null
  | { status: "identity_taken" }
  | { status: "found"; linked: boolean; id: string; name: string | null; language: string | null; country: string | null; updatedAt: Date; doNotContact: boolean };

export type CrmCreateInput = {
  externalId: string;
  name: string | null;
  emailRaw: string | null;
  emailNormalized: string | null;
  phoneE164: string | null;
  language: string | null;
  country: string | null;
};
export type CrmWriteStatus = "created" | "exists" | "invalid" | "quota_exceeded" | "updated" | "do_not_contact" | "identity_taken" | "not_found";

export type CrmCounts = { created: number; updated: number; linked: number; unchanged: number; skipped: number; rejected: number; conflicts: number };
export type CrmFailCode = "file_missing" | "file_malformed" | "mapping_invalid" | "failed";

export interface CrmSyncGateway {
  start(organizationId: string, integrationId: string, batchId: string): Promise<CrmSyncStart>;
  readFile(path: string): Promise<Uint8Array | null>;
  find(organizationId: string, provider: string, externalId: string, emailNormalized: string | null, phoneE164: string | null): Promise<CrmFound>;
  create(organizationId: string, provider: string, input: CrmCreateInput): Promise<{ status: CrmWriteStatus }>;
  update(organizationId: string, contactId: string, provider: string, externalId: string, fields: Record<string, string | null>): Promise<{ status: CrmWriteStatus }>;
  auditConflict(organizationId: string, integrationId: string, contactId: string, conflicts: Array<{ field: string; winner: string }>): Promise<void>;
  finish(organizationId: string, integrationId: string, batchId: string, startedAt: Date, counts: CrmCounts): Promise<void>;
  fail(organizationId: string, integrationId: string, code: CrmFailCode): Promise<void>;
}

export class CrmSyncGatewayError extends Error {
  constructor(operation: string) {
    super(`crm_sync_${operation}_failed`);
    this.name = "CrmSyncGatewayError";
  }
}

export type CrmSyncEnv = { SUPABASE_URL: string; SUPABASE_SECRET_KEY: string };

const startSchema = z.union([
  z.object({
    status: z.literal("running"), path: z.string(), provider: z.string(), source: z.string(), last_sync_at: z.string().nullable(),
    last_sync_finished_at: z.string().nullable(), started_at: z.string(), mappings: z.unknown(),
  }),
  z.object({ status: z.enum(["missing", "file_missing"]) }),
]);
const foundSchema = z.union([
  z.null(),
  z.object({ status: z.literal("identity_taken") }),
  z.object({
    status: z.literal("found"),
    linked: z.boolean(),
    id: z.uuid(),
    name: z.string().nullable(),
    language: z.string().nullable(),
    country: z.string().nullable(),
    updated_at: z.string(),
    do_not_contact: z.boolean(),
  }),
]);
const writeSchema = z.object({ status: z.enum(["created", "exists", "invalid", "quota_exceeded", "updated", "do_not_contact", "identity_taken", "not_found"]) });

/** Les erreurs de transport ne transportent ni URL, ni clé, ni message SQL, ni valeur de contact. */
export function createSupabaseCrmSyncGateway(env: CrmSyncEnv): CrmSyncGateway {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    async start(organizationId, integrationId, batchId) {
      const { data, error } = await client.rpc("crm_sync_start", { p_org: organizationId, p_integration: integrationId, p_batch: batchId });
      if (error) throw new CrmSyncGatewayError("start");
      const parsed = startSchema.safeParse(data);
      if (!parsed.success) throw new CrmSyncGatewayError("start");
      if (parsed.data.status !== "running") return { status: parsed.data.status };
      return {
        status: "running",
        path: parsed.data.path,
        provider: parsed.data.provider,
        source: parsed.data.source,
        lastSyncAt: parsed.data.last_sync_at ? new Date(parsed.data.last_sync_at) : null,
        lastSyncFinishedAt: parsed.data.last_sync_finished_at ? new Date(parsed.data.last_sync_finished_at) : null,
        startedAt: new Date(parsed.data.started_at),
        mappings: parsed.data.mappings,
      };
    },
    async readFile(path) {
      const { data, error } = await client.storage.from("imports").download(path);
      if (error || !data) {
        const status = String((error as { statusCode?: string | number } | null)?.statusCode ?? "");
        if (status === "404" || /not found/i.test(error?.message ?? "")) return null;
        throw new CrmSyncGatewayError("read");
      }
      return new Uint8Array(await data.arrayBuffer());
    },
    async find(organizationId, provider, externalId, emailNormalized, phoneE164) {
      const { data, error } = await client.rpc("crm_sync_find", {
        p_org: organizationId, p_provider: provider, p_external_id: externalId, p_email_normalized: emailNormalized, p_phone_e164: phoneE164,
      });
      if (error) throw new CrmSyncGatewayError("find");
      const parsed = foundSchema.safeParse(data);
      if (!parsed.success) throw new CrmSyncGatewayError("find");
      const value = parsed.data;
      if (value === null || value.status === "identity_taken") return value;
      return {
        status: "found", linked: value.linked, id: value.id, name: value.name, language: value.language, country: value.country,
        updatedAt: new Date(value.updated_at), doNotContact: value.do_not_contact,
      };
    },
    async create(organizationId, provider, input) {
      const { data, error } = await client.rpc("crm_sync_create", {
        p_org: organizationId, p_provider: provider, p_external_id: input.externalId, p_name: input.name, p_email_raw: input.emailRaw,
        p_email_normalized: input.emailNormalized, p_phone_e164: input.phoneE164, p_language: input.language, p_country: input.country,
      });
      if (error) throw new CrmSyncGatewayError("create");
      const parsed = writeSchema.safeParse(data);
      if (!parsed.success) throw new CrmSyncGatewayError("create");
      return parsed.data;
    },
    async update(organizationId, contactId, provider, externalId, fields) {
      const { data, error } = await client.rpc("crm_sync_update", {
        p_org: organizationId, p_contact: contactId, p_provider: provider, p_external_id: externalId, p_fields: fields,
      });
      if (error) throw new CrmSyncGatewayError("update");
      const parsed = writeSchema.safeParse(data);
      if (!parsed.success) throw new CrmSyncGatewayError("update");
      return parsed.data;
    },
    async auditConflict(organizationId, integrationId, contactId, conflicts) {
      const { error } = await client.rpc("crm_sync_audit_conflict", { p_org: organizationId, p_integration: integrationId, p_contact: contactId, p_conflicts: conflicts });
      if (error) throw new CrmSyncGatewayError("audit");
    },
    async finish(organizationId, integrationId, batchId, startedAt, counts) {
      const { error } = await client.rpc("crm_sync_finish", { p_org: organizationId, p_integration: integrationId, p_batch: batchId, p_started_at: startedAt.toISOString(), p_counts: counts });
      if (error) throw new CrmSyncGatewayError("finish");
    },
    async fail(organizationId, integrationId, code) {
      const { error } = await client.rpc("crm_sync_fail", { p_org: organizationId, p_integration: integrationId, p_code: code });
      if (error) throw new CrmSyncGatewayError("fail");
    },
  };
}
