import { IMPORT_MAX_BYTES, uuidSchema } from "@fusion-leap/domain";
import { getImportBatch, listImportBatches, uploadImport } from "../../../lib/imports/service";
import { ServiceError } from "../../../lib/service/errors";
import { readBoundedBytes, withRoute } from "../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/**
 * Import CSV de leads (J23), étape 1 : `POST /api/imports?project_id=<uuid>` avec le fichier BRUT (`Content-Type: text/csv`, 10 Mo au
 * plus, UTF-8). Le fichier est vérifié (encodage, structure, 10 000 lignes au plus), envoyé au Storage privé avec les droits de
 * l'utilisateur, puis enregistré comme lot ; RIEN n'est écrit dans les contacts. Réponse 201 `{ batch_id, row_count, columns }`.
 * `GET /api/imports` liste les lots ; `GET /api/imports?id=<uuid>` donne l'état et les compteurs d'un lot.
 *
 *  - Rôles : owner et admin (la fonction SQL et les politiques Storage revérifient) ; l'entreprise est celle du contexte vérifié.
 *  - Pas d'`Idempotency-Key` ici : chaque envoi est un nouveau lot NON confirmé (sans effet sur les contacts) ; la confirmation, elle,
 *    exige la clé.
 */
const uploadSchema = {
  safeParse(input: unknown) {
    const project = uuidSchema.safeParse((input as { projectId?: unknown } | null)?.projectId);
    return project.success ? { success: true as const, data: { projectId: project.data } } : { success: false as const, error: { issues: [] } };
  },
};

export const POST = withRoute(
  {
    name: "imports.upload",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: "none",
    permission: { action: "create", resource: "projects" },
    schema: uploadSchema,
    // Le corps (10 Mo) n'est PAS lu ici : seules la query et le type de contenu le sont ; il est lu par le handler, APRÈS
    // l'authentification, le contrôle de rôle et la limite de débit (revue sécurité : pas de 10 Mo en mémoire pour un anonyme).
    readBody: async (request) => {
      const type = (request.headers.get("content-type") ?? "").toLowerCase();
      if (!type.startsWith("text/csv") && !type.startsWith("text/plain")) throw new ServiceError("validation_failed");
      return { projectId: new URL(request.url).searchParams.get("project_id") };
    },
  },
  async (ctx, input) => {
    const bytes = await readBoundedBytes(ctx.request, IMPORT_MAX_BYTES);
    const result = await uploadImport(ctx.supabase, ctx.organizationId, { projectId: input.projectId, bytes });
    if (!result.ok) throw new ServiceError(result.code);
    return { status: 201, body: { batch_id: result.value.batchId, row_count: result.value.rowCount, columns: result.value.columns } };
  },
);

const listSchema = {
  safeParse(input: unknown) {
    const id = (input as { id?: unknown } | null)?.id;
    if (id === undefined) return { success: true as const, data: { id: null as string | null } };
    const parsed = uuidSchema.safeParse(id);
    return parsed.success ? { success: true as const, data: { id: parsed.data as string | null } } : { success: false as const, error: { issues: [] } };
  },
};

export const GET = withRoute(
  {
    name: "imports.read",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: "none",
    permission: { action: "create", resource: "projects" },
    schema: listSchema,
  },
  async (ctx, input) => {
    if (input.id) {
      const batch = await getImportBatch(ctx.supabase, ctx.organizationId, input.id);
      if (!batch) throw new ServiceError("not_found");
      return { status: 200, body: { batch } };
    }
    return { status: 200, body: { batches: await listImportBatches(ctx.supabase, ctx.organizationId) } };
  },
);
