import { z } from "zod";

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
 * `lead.assign` (enregistré par la capture publique, J21) : handler PROVISOIRE sans effet. Les règles d'assignation, la file
 * « non assignés » et l'alerte au manager sont le J22 ; en attendant, le lead reste dans l'étape « non assigné » (repli prévu
 * par la spec §9.1) et le job se termine proprement au lieu de finir en échec définitif (type inconnu).
 */
export const leadAssignHandler = defineHandler({
  kind: "lead.assign",
  schema: z.object({ lead_id: z.uuid() }).strict(),
  run: async () => {},
});

export function createDefaultRegistry(): HandlerRegistry {
  return new HandlerRegistry().register(noopHandler).register(leadAssignHandler);
}
