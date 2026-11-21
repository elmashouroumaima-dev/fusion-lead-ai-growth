import { replyInputSchema } from "@fusion-leap/domain";
import { describe, expect, it, vi } from "vitest";
import { mapLeadsDbError } from "../leads/map-error";
import { acquireConversationLock, getConversationLock, releaseConversationLock, replyToConversation, takeOverConversation } from "./service";

const ORG = "22222222-2222-4222-8222-222222222222";
const CONV = "11111111-1111-4111-8111-111111111111";
const MSG = "33333333-3333-4333-8333-333333333333";
const KEY = "reply-key-0001";

describe("replyInputSchema", () => {
  it("accepte 1 à 10 000 caractères et refuse le vide, le trop long, les champs en plus (dont organization_id)", () => {
    expect(replyInputSchema.safeParse({ body: "Bonjour" }).success).toBe(true);
    expect(replyInputSchema.safeParse({ body: "x".repeat(10_000) }).success).toBe(true);
    expect(replyInputSchema.safeParse({ body: "x".repeat(10_001) }).success).toBe(false);
    expect(replyInputSchema.safeParse({ body: "" }).success).toBe(false);
    expect(replyInputSchema.safeParse({ body: "   " }).success).toBe(false);
    expect(replyInputSchema.safeParse({ body: "a", organization_id: ORG }).success).toBe(false);
    expect(replyInputSchema.safeParse({}).success).toBe(false);
  });

  it("refuse les caractères de direction invisibles", () => {
    expect(replyInputSchema.safeParse({ body: "a‮b" }).success).toBe(false);
  });
});

describe("replyToConversation", () => {
  it("appelle conversation_reply avec l'entreprise du contexte, la conversation, le corps et la clé", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { message_id: MSG, duplicate: false }, error: null });
    const result = await replyToConversation({ rpc } as never, ORG, CONV, { body: "Bonjour" }, KEY);
    expect(rpc).toHaveBeenCalledWith("conversation_reply", { p_org: ORG, p_conversation: CONV, p_body: "Bonjour", p_idempotency_key: KEY });
    expect(result).toEqual({ ok: true, value: { message_id: MSG, duplicate: false } });
  });

  it("traduit les erreurs de la base en codes d'API, sans message brut", async () => {
    const run = async (error: { code: string; message: string }) =>
      replyToConversation({ rpc: vi.fn().mockResolvedValue({ data: null, error }) } as never, ORG, CONV, { body: "x" }, KEY);
    expect(await run({ code: "42501", message: "forbidden" })).toEqual({ ok: false, code: "forbidden" });
    expect(await run({ code: "PT404", message: "not found" })).toEqual({ ok: false, code: "not_found" });
    for (const reason of ["conversation_locked", "channel_unsupported", "channel_inactive", "message_not_approvable", "window_closed", "idempotency_conflict"]) {
      expect(await run({ code: "P0001", message: reason })).toEqual({ ok: false, code: "conflict" });
      expect(mapLeadsDbError({ code: "P0001", message: reason })).toBe("conflict");
    }
    expect(await run({ code: "22023", message: "invalid" })).toEqual({ ok: false, code: "validation_failed" });
  });

  it("une réponse illisible de la base est une erreur interne", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { nope: 1 }, error: null });
    expect(await replyToConversation({ rpc } as never, ORG, CONV, { body: "x" }, KEY)).toEqual({ ok: false, code: "internal_error" });
  });
});

describe("verrou", () => {
  it("lit l'état du verrou sans identité", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { handled_by: "human", lock: "other" }, error: null });
    expect(await getConversationLock({ rpc } as never, ORG, CONV)).toEqual({ ok: true, value: { handled_by: "human", lock: "other" } });
    expect(rpc).toHaveBeenCalledWith("conversation_lock_status", { p_org: ORG, p_conversation: CONV });
  });

  it("prend le bail : acquis, tenu par un autre, ou tenu par l'IA", async () => {
    for (const status of ["acquired", "held_by_other", "ai"] as const) {
      const rpc = vi.fn().mockResolvedValue({ data: { status, expires_at: "2026-12-10T10:05:00Z" }, error: null });
      const result = await acquireConversationLock({ rpc } as never, ORG, CONV);
      expect(result.ok && result.value.status).toBe(status);
    }
    expect(await acquireConversationLock({ rpc: vi.fn().mockResolvedValue({ data: { status: "x" }, error: null }) } as never, ORG, CONV)).toEqual({ ok: false, code: "internal_error" });
  });

  it("libère le bail et reprend la main", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    expect(await releaseConversationLock({ rpc } as never, ORG, CONV)).toEqual({ ok: true, value: true });
    expect(await takeOverConversation({ rpc } as never, ORG, CONV)).toEqual({ ok: true, value: true });
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["conversation_lock_release", "conversation_take_over"]);
  });
});
