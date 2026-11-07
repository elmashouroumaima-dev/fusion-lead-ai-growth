import { describe, expect, it } from "vitest";
import { z } from "zod";
import { errorCode, NonRetryableError, safeCode } from "./errors";
import { createDefaultRegistry, defineHandler, HandlerRegistry, noopHandler } from "./handlers";

describe("HandlerRegistry", () => {
  it("enregistre noop par défaut ; un type absent est introuvable", () => {
    const registry = createDefaultRegistry();
    expect(registry.kinds()).toEqual(["noop"]);
    expect(registry.get("noop")).toBe(noopHandler);
    expect(registry.get("autre")).toBeUndefined();
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
