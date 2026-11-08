import { z } from "zod";
import { CsvError, CsvParser, detectDelimiter, IMPORT_MAX_BYTES, normalizeImportRow } from "@fusion-leap/domain";
import type { LeadAssigner } from "./assignment";
import { NonRetryableError } from "./errors";
import { ImportGatewayError, type ImportGateway } from "./imports";

/**
 * Contexte d'exécution d'un job. `organizationId` vient de la ligne du job (jamais de la charge utile) : tout
 * handler DOIT l'appliquer explicitement à chaque lecture ou écriture (le worker utilise service_role, qui
 * contourne la RLS ; spec §11, ADR 003).
 */
export type JobContext = {
  jobId: string;
  organizationId: string;
  idempotencyKey: string;
  attempt: number;
  maxAttempts: number;
  /** Déclenché si le bail est perdu ou à l'arrêt forcé : le handler doit s'interrompre. */
  signal: AbortSignal;
};

/** Handler typé : la charge utile est validée par `schema` AVANT l'appel de `run`. */
export type JobHandler = {
  readonly kind: string;
  parse(payload: unknown): { success: true; data: unknown } | { success: false };
  run(ctx: JobContext, payload: unknown): Promise<void>;
};

const KIND = /^[a-z0-9_.]{1,64}$/;

export function defineHandler<S extends z.ZodType>(definition: {
  kind: string;
  schema: S;
  run: (ctx: JobContext, payload: z.output<S>) => Promise<void>;
}): JobHandler {
  if (!KIND.test(definition.kind)) throw new Error("handler_kind_invalid");
  return {
    kind: definition.kind,
    parse(payload) {
      const parsed = definition.schema.safeParse(payload);
      return parsed.success ? { success: true, data: parsed.data } : { success: false };
    },
    run: (ctx, payload) => definition.run(ctx, payload as z.output<S>),
  };
}

/** Registre des handlers par type de job. Un type inconnu est un échec définitif (jamais réessayé). */
export class HandlerRegistry {
  private readonly handlers = new Map<string, JobHandler>();

  register(handler: JobHandler): this {
    if (this.handlers.has(handler.kind)) throw new Error("handler_already_registered");
    this.handlers.set(handler.kind, handler);
    return this;
  }

  get(kind: string): JobHandler | undefined {
    return this.handlers.get(kind);
  }

  kinds(): string[] {
    return [...this.handlers.keys()].sort();
  }
}

/** Job de démonstration : ne fait rien (sert à vérifier la chaîne complète file → worker → base). */
export const noopHandler = defineHandler({
  kind: "noop",
  schema: z.record(z.string(), z.unknown()),
  run: async () => {},
});

/**
 * `lead.assign` (enregistré par la capture publique, J21 ; spec §9.1 étape 4). L'entreprise est celle de la LIGNE DU JOB ; la charge
 * utile ne porte que l'identifiant du lead. Idempotent : un lead déjà assigné (ou plus dans la file « non assignés ») est ignoré,
 * donc un rejeu ne réassigne pas. Sans règle ni membre éligible, la base laisse le lead « non assigné » et alerte les admins
 * (réussite du job). Une erreur technique est réessayée ; à la dernière tentative, le lead reste « non assigné » et les admins
 * sont alertés avant l'échec définitif.
 */
export function createLeadAssignHandler(assigner: LeadAssigner): JobHandler {
  return defineHandler({
    kind: "lead.assign",
    schema: z.object({ lead_id: z.uuid() }).strict(),
    run: async (ctx, payload) => {
      try {
        await assigner.assign(ctx.organizationId, payload.lead_id);
      } catch (error) {
        if (ctx.attempt >= ctx.maxAttempts) {
          try {
            await assigner.flagUnassigned(ctx.organizationId, payload.lead_id);
          } catch {
            // l'alerte est un effort ; l'erreur d'origine reste celle du job
          }
        }
        throw error;
      }
    },
  });
}

/**
 * `import_csv` (J23, plan J23) : crée contacts et leads d'un lot d'import CONFIRMÉ. L'entreprise est celle de la LIGNE DU JOB ; la charge
 * utile ne porte que l'identifiant du lot. Le fichier (Storage privé, 10 Mo au plus) est lu en une fois puis analysé ligne par ligne ;
 * chaque ligne passe par `import_row` (même dédup que la capture publique, AUCUN consentement créé, rapport sans donnée de contact).
 * Rejeu : chaque ligne est enregistrée une seule fois côté base ; un lot terminé, annulé ou inconnu est ignoré. Fichier absent ou
 * illisible, trop de lignes, abonnement inactif : échec définitif du lot (code seulement). Panne technique : réessayée ; à la dernière
 * tentative le lot est marqué « failed » (il ne reste jamais « running »).
 */
export function createImportCsvHandler(gateway: ImportGateway): JobHandler {
  return defineHandler({
    kind: "import_csv",
    schema: z.object({ batch_id: z.uuid() }).strict(),
    run: async (ctx, payload) => {
      const org = ctx.organizationId;
      const batch = payload.batch_id;
      try {
        await runImport(gateway, ctx, org, batch);
      } catch (error) {
        if (error instanceof NonRetryableError) throw error;
        if (error instanceof ImportGatewayError && (error.kind === "subscription_inactive" || error.kind === "project_archived")) {
          await bestEffort(() => gateway.fail(org, batch, error.kind as "subscription_inactive" | "project_archived"));
          throw new NonRetryableError(error.kind);
        }
        if (ctx.attempt >= ctx.maxAttempts) await bestEffort(() => gateway.fail(org, batch, "failed"));
        throw error;
      }
    },
  });
}

async function bestEffort(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch {
    // l'erreur d'origine reste celle du job
  }
}

async function runImport(gateway: ImportGateway, ctx: JobContext, org: string, batch: string): Promise<void> {
  const started = await gateway.start(org, batch);
  if (started.status !== "running") return;

  const bytes = await gateway.readFile(started.path);
  if (bytes === null) {
    await gateway.fail(org, batch, "file_missing");
    throw new NonRetryableError("file_missing");
  }
  let rows: string[][];
  try {
    if (bytes.byteLength > IMPORT_MAX_BYTES) throw new CsvError("too_many_rows");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    rows = [];
    const parser = new CsvParser(detectDelimiter(text));
    for (let offset = 0; offset < text.length; offset += 65536) rows.push(...parser.push(text.slice(offset, offset + 65536)));
    rows.push(...parser.end());
  } catch (error) {
    const code = error instanceof CsvError && error.code === "too_many_rows" ? "too_many_rows" : "file_malformed";
    await gateway.fail(org, batch, code);
    throw new NonRetryableError(code);
  }

  // rows[0] = en-tête ; les numéros de ligne du rapport sont ceux du fichier (en-tête = ligne 1)
  for (let index = 1; index < rows.length; index += 1) {
    if (ctx.signal.aborted) throw new Error("aborted");
    const rowNo = index + 1;
    const normalized = normalizeImportRow(rows[index] as string[], started.mapping, started.defaultCountry);
    if (normalized.ok) await gateway.row(org, batch, rowNo, normalized.value);
    else await gateway.rowError(org, batch, rowNo, normalized.reason);
  }
  await gateway.finish(org, batch, Math.max(rows.length - 1, 0));
}

export type RegistryDeps = { assigner: LeadAssigner; imports: ImportGateway };

export function createDefaultRegistry(deps: RegistryDeps): HandlerRegistry {
  return new HandlerRegistry()
    .register(noopHandler)
    .register(createLeadAssignHandler(deps.assigner))
    .register(createImportCsvHandler(deps.imports));
}
