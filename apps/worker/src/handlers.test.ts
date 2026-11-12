import { MemoryWebhooks } from "./webhooks.testkit";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { errorCode, NonRetryableError, safeCode } from "./errors";
import { MemoryAssigner } from "./assigner.testkit";
import { MemoryCrm } from "./crm-sync.testkit";
import { MemoryImports } from "./imports.testkit";
import { noSend } from "./send.testkit";
import { createDefaultRegistry, createLeadAssignHandler, defineHandler, HandlerRegistry, noopHandler } from "./handlers";
import type { JobContext } from "./handlers";

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "33333333-3333-4333-8333-333333333333";
const ctx = (over: Partial<JobContext> = {}): JobContext => ({
  jobId: "44444444-4444-4444-8444-444444444444", organizationId: ORG, idempotencyKey: "k", attempt: 1, maxAttempts: 3, signal: new AbortController().signal, ...over,
});
const leadAssignHandler = createLeadAssignHandler(new MemoryAssigner());

describe("HandlerRegistry", () => {
  it("enregistre noop et lead.assign par défaut ; un type absent est introuvable", () => {
    const registry = createDefaultRegistry({ assigner: new MemoryAssigner(), imports: new MemoryImports(), crm: new MemoryCrm(), send: noSend(), webhooks: { gateway: new MemoryWebhooks(), processors: new Map() } });
    expect(registry.kinds()).toEqual(["crm_sync", "import_csv", "lead.assign", "noop", "process_webhook", "send_message"]);
    expect(registry.get("noop")).toBe(noopHandler);
    expect(registry.get("lead.assign")?.kind).toBe("lead.assign");
    expect(registry.get("autre")).toBeUndefined();
  });

  it("lead.assign : charge utile = identifiant du lead seulement", () => {
    expect(leadAssignHandler.parse({ lead_id: "11111111-1111-4111-8111-111111111111" }).success).toBe(true);
    expect(leadAssignHandler.parse({ lead_id: "x" }).success).toBe(false);
    expect(leadAssignHandler.parse({ lead_id: "11111111-1111-4111-8111-111111111111", email: "a@b.c" }).success).toBe(false);
  });

  it("refuse un doublon et un type mal formé", () => {
    const registry = new HandlerRegistry().register(noopHandler);
    expect(() => registry.register(noopHandler)).toThrow("handler_already_registered");
    expect(() => defineHandler({ kind: "Bad Kind", schema: z.object({}), run: async () => {} })).toThrow("handler_kind_invalid");
  });

  it("valide la charge utile avec le schéma du handler", () => {
    const handler = defineHandler({ kind: "send", schema: z.object({ message_id: z.uuid() }).strict(), run: async () => {} });
    expect(handler.parse({ message_id: "11111111-1111-4111-8111-111111111111" }).success).toBe(true);
    expect(handler.parse({ message_id: "x" }).success).toBe(false);
    expect(handler.parse({ message_id: "11111111-1111-4111-8111-111111111111", body: "texte" }).success).toBe(false);
  });
});

describe("lead.assign", () => {
  it("assigne avec l'entreprise de la LIGNE DU JOB (jamais de la charge utile)", async () => {
    const assigner = new MemoryAssigner();
    await createLeadAssignHandler(assigner).run(ctx(), { lead_id: LEAD });
    expect(assigner.assigned).toEqual([{ organizationId: ORG, leadId: LEAD }]);
    expect(assigner.flagged).toEqual([]);
  });

  it("lead resté non assigné (sans règle) : le job réussit, la base a alerté", async () => {
    const assigner = new MemoryAssigner();
    assigner.result = { outcome: "unassigned", reason: "no_rule" };
    await expect(createLeadAssignHandler(assigner).run(ctx(), { lead_id: LEAD })).resolves.toBeUndefined();
    expect(assigner.flagged).toEqual([]);
  });

  it("erreur technique avant la dernière tentative : relancée (job réessayé), pas d'alerte", async () => {
    const assigner = new MemoryAssigner();
    assigner.failAssign = true;
    await expect(createLeadAssignHandler(assigner).run(ctx({ attempt: 1 }), { lead_id: LEAD })).rejects.toThrow("assignment_assign_failed");
    expect(assigner.flagged).toEqual([]);
  });

  it("dernière tentative : alerte les admins puis relance l'erreur d'origine", async () => {
    const assigner = new MemoryAssigner();
    assigner.failAssign = true;
    await expect(createLeadAssignHandler(assigner).run(ctx({ attempt: 3 }), { lead_id: LEAD })).rejects.toThrow("assignment_assign_failed");
    expect(assigner.flagged).toEqual([{ organizationId: ORG, leadId: LEAD }]);
  });

  it("l'échec de l'alerte ne masque pas l'erreur d'origine", async () => {
    const assigner = new MemoryAssigner();
    assigner.failAssign = true;
    assigner.failFlag = true;
    await expect(createLeadAssignHandler(assigner).run(ctx({ attempt: 3 }), { lead_id: LEAD })).rejects.toThrow("assignment_assign_failed");
  });
});

describe("codes d'erreur", () => {
  it("réduit à un alphabet sûr, 64 caractères au plus", () => {
    expect(safeCode("a b/c;d")).toBe("a_b_c_d");
    expect(safeCode("x".repeat(100))).toHaveLength(64);
    expect(safeCode("")).toBe("error");
  });
  it("nom de l'erreur, jamais son message ; code d'une NonRetryableError", () => {
    expect(errorCode(new RangeError("secret"))).toBe("RangeError");
    expect(errorCode(new NonRetryableError("do not contact"))).toBe("do_not_contact");
    expect(errorCode("chaîne")).toBe("error");
    expect(errorCode(null)).toBe("error");
  });
});
