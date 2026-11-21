import { replyInputSchema, uuidSchema } from "@fusion-leap/domain";
import { replyToConversation } from "../../../../../lib/conversations/service";
import { ServiceError } from "../../../../../lib/service/errors";
import { withRoute } from "../../../../../lib/service/with-service";

export const dynamic = "force-dynamic";

/**
 * Répondre à une conversation (J38) : `POST /api/conversations/:id/replies` `{ body }` (1 à 10 000 caractères).
 * La réponse est créée ET approuvée par son auteur dans une transaction, puis mise en file : `202 { message_id, status: "queued" }`.
 * C'est le WORKER qui envoie, après le contrôle final (consentement, do_not_contact, suppression, pauses, expéditeur). Rôles (ADR 014
 * ligne 18) : owner et admin sur toute conversation, commercial sur celles qui lui sont assignées (la base le revérifie : sinon 404),
 * marketing et analyste 403. `Idempotency-Key` obligatoire (le rejeu renvoie le même `message_id`). Verrou : 409 si un autre membre
 * rédige ou si l'IA tient la conversation. E-mail, et WhatsApp en TEXTE LIBRE dans la fenêtre de 24 h seulement (fenêtre fermée : 409 `conflict`, aucun message créé). Le corps n'est ni journalisé ni audité.
 * L'identifiant de conversation vient de l'adresse ; l'entreprise, du contexte vérifié.
 */
export const POST = withRoute(
  {
    name: "conversations.reply",
    auth: "tenant",
    rateLimit: "mutation",
    idempotency: { mode: "required", storeResponse: true },
    // `isOwnRecord: true` : l'attribution n'est connue que de la base (la fonction SQL refuse le commercial non assigné).
    permission: { action: "reply", resource: "conversations", ctx: () => ({ isOwnRecord: true }) },
    schema: replyInputSchema,
    bodyLimitBytes: 64 * 1024,
  },
  async (ctx, input) => {
    const segments = new URL(ctx.request.url).pathname.split("/");
    const id = uuidSchema.safeParse(segments[segments.length - 2]);
    if (!id.success) throw new ServiceError("not_found");
    const key = ctx.request.headers.get("idempotency-key") ?? "";
    const result = await replyToConversation(ctx.supabase, ctx.organizationId, id.data, input, key);
    if (!result.ok) throw new ServiceError(result.code);
    return { status: 202, body: { message_id: result.value.message_id, status: "queued" } };
  },
);
