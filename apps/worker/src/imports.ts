import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { IMPORT_REASONS, importMappingSchema, type ImportMapping, type ImportRowValue } from "@fusion-leap/domain";

/**
 * Accès du worker à l'import CSV (J23). Une seule implémentation de production (RPC Supabase et Storage avec la clé service_role,
 * fonctions SQL réservées à ce rôle) ; les tests injectent une version en mémoire. L'entreprise est TOUJOURS celle de la ligne du job.
 */
export type ImportStart =
  | { status: "running"; path: string; mapping: ImportMapping; defaultCountry: string | null; projectId: string }
  | { status: "missing" | "done" | "failed" | "cancelled" | "uploaded" };

export type ImportRowOutcome = { outcome: "created" | "matched" | "skipped" | "error"; reason: string | null; leadCreated: boolean };

export type ImportFailCode = "file_missing" | "file_malformed" | "too_many_rows" | "subscription_inactive" | "project_archived" | "failed";

export interface ImportGateway {
  start(organizationId: string, batchId: string): Promise<ImportStart>;
  /** Octets du fichier, ou `null` s'il n'existe plus. */
  readFile(path: string): Promise<Uint8Array | null>;
  row(organizationId: string, batchId: string, rowNo: number, value: ImportRowValue): Promise<ImportRowOutcome>;
  rowError(organizationId: string, batchId: string, rowNo: number, reason: string): Promise<void>;
  finish(organizationId: string, batchId: string, rowCount: number): Promise<void>;
  fail(organizationId: string, batchId: string, code: ImportFailCode): Promise<void>;
}

export class ImportGatewayError extends Error {
  /** `subscription_inactive` et `project_archived` : définitifs ; tout le reste est une panne réessayable. */
  readonly kind: "subscription_inactive" | "project_archived" | "failed";
  constructor(operation: string, kind: "subscription_inactive" | "project_archived" | "failed" = "failed") {
    super(`import_${operation}_failed`);
    this.name = "ImportGatewayError";
    this.kind = kind;
  }
}

export type ImportEnv = { SUPABASE_URL: string; SUPABASE_SECRET_KEY: string };

const startSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("running"),
    path: z.string(),
    mapping: importMappingSchema,
    default_country: z.string().nullable(),
    project_id: z.uuid(),
  }),
  z.object({ status: z.enum(["missing", "done", "failed", "cancelled", "uploaded"]) }),
]);
const rowSchema = z.object({
  outcome: z.enum(["created", "matched", "skipped", "error"]),
  reason: z.enum(IMPORT_REASONS).nullable(),
  lead_created: z.boolean(),
});

/** Les erreurs de transport ne transportent ni URL, ni clé, ni message SQL, ni valeur de contact. */
export function createSupabaseImportGateway(env: ImportEnv): ImportGateway {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const kindOf = (error: { message?: string } | null): "subscription_inactive" | "project_archived" | "failed" => {
    const message = error?.message ?? "";
    if (message.includes("subscription_inactive")) return "subscription_inactive";
    return message.includes("project_archived") ? "project_archived" : "failed";
  };

  return {
    async start(organizationId, batchId) {
      const { data, error } = await client.rpc("import_start", { p_org: organizationId, p_batch: batchId });
      if (error) throw new ImportGatewayError("start");
      const parsed = startSchema.safeParse(data);
      if (!parsed.success) throw new ImportGatewayError("start");
      if (parsed.data.status !== "running") return { status: parsed.data.status };
      return {
        status: "running",
        path: parsed.data.path,
        mapping: parsed.data.mapping,
        defaultCountry: parsed.data.default_country,
        projectId: parsed.data.project_id,
      };
    },
    async readFile(path) {
      const { data, error } = await client.storage.from("imports").download(path);
      if (error || !data) {
        const status = String((error as { statusCode?: string | number } | null)?.statusCode ?? "");
        if (status === "404" || /not found/i.test(error?.message ?? "")) return null;
        throw new ImportGatewayError("read");
      }
      return new Uint8Array(await data.arrayBuffer());
    },
    async row(organizationId, batchId, rowNo, value) {
      const { data, error } = await client.rpc("import_row", {
        p_org: organizationId,
        p_batch: batchId,
        p_row: rowNo,
        p_name: value.name,
        p_email_raw: value.email_raw,
        p_email_normalized: value.email_normalized,
        p_phone_e164: value.phone_e164,
        p_language: value.language,
        p_country: value.country,
      });
      if (error) throw new ImportGatewayError("row", kindOf(error));
      const parsed = rowSchema.safeParse(data);
      if (!parsed.success) throw new ImportGatewayError("row");
      return { outcome: parsed.data.outcome, reason: parsed.data.reason, leadCreated: parsed.data.lead_created };
    },
    async rowError(organizationId, batchId, rowNo, reason) {
      const { error } = await client.rpc("import_record_error", { p_org: organizationId, p_batch: batchId, p_row: rowNo, p_reason: reason });
      if (error) throw new ImportGatewayError("row_error");
    },
    async finish(organizationId, batchId, rowCount) {
      const { error } = await client.rpc("import_finish", { p_org: organizationId, p_batch: batchId, p_rows: rowCount });
      if (error) throw new ImportGatewayError("finish");
    },
    async fail(organizationId, batchId, code) {
      const { error } = await client.rpc("import_fail", { p_org: organizationId, p_batch: batchId, p_code: code });
      if (error) throw new ImportGatewayError("fail");
    },
  };
}
