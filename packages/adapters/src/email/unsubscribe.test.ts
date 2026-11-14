import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createKeyRing } from "../secrets/crypto";
import { appendUnsubscribeFooter, createUnsubscribeToken, listUnsubscribeHeaders, unsubscribeUrl, verifyUnsubscribeToken } from "./unsubscribe";

const b64 = () => randomBytes(32).toString("base64");
const ORG = "11111111-1111-4111-8111-111111111111";
const MSG = "22222222-2222-4222-8222-222222222222";
const claims = { organizationId: ORG, messageId: MSG };

describe("jeton de désabonnement", () => {
  const ring = createKeyRing(1, { 1: b64() });

  it("aller-retour : le jeton rend l'entreprise et le message", () => {
    const token = createUnsubscribeToken(ring, claims);
    expect(token).toMatch(/^v1\.1\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(verifyUnsubscribeToken(ring, token)).toEqual(claims);
  });

  it("ne contient aucune donnée personnelle (ni adresse, ni nom)", () => {
    const token = createUnsubscribeToken(ring, claims);
    expect(token).not.toMatch(/@/);
  });

  it("refuse une signature modifiée, un autre message, une autre entreprise", () => {
    const token = createUnsubscribeToken(ring, claims);
    const parts = token.split(".");
    const sig = parts[4] as string;
    expect(verifyUnsubscribeToken(ring, [...parts.slice(0, 4), (sig.startsWith("A") ? "B" : "A") + sig.slice(1)].join("."))).toBeNull();
    expect(verifyUnsubscribeToken(ring, [parts[0], parts[1], parts[2], "33333333-3333-4333-8333-333333333333", sig].join("."))).toBeNull();
    expect(verifyUnsubscribeToken(ring, [parts[0], parts[1], "33333333-3333-4333-8333-333333333333", parts[3], sig].join("."))).toBeNull();
  });

  it("refuse les formats invalides sans lever d'erreur", () => {
    for (const bad of ["", "abc", "v1.1.x.y.z", `v2.1.${ORG}.${MSG}.${"A".repeat(43)}`, `v1.1.${ORG}.${MSG}.${"A".repeat(42)}`, `v1.01.${ORG}.${MSG}.${"A".repeat(43)}`, `v1.0.${ORG}.${MSG}.${"A".repeat(43)}`, "x".repeat(500)]) {
      expect(verifyUnsubscribeToken(ring, bad)).toBeNull();
    }
  });

  it("clé différente : refusé ; rotation : l'ancien lien reste valide tant que l'ancienne clé est au trousseau", () => {
    const k1 = b64();
    const old = createKeyRing(1, { 1: k1 });
    const token = createUnsubscribeToken(old, claims);
    expect(verifyUnsubscribeToken(createKeyRing(1, { 1: b64() }), token)).toBeNull();
    const rotated = createKeyRing(2, { 1: k1, 2: b64() });
    expect(verifyUnsubscribeToken(rotated, token)).toEqual(claims);
    expect(createUnsubscribeToken(rotated, claims).startsWith("v1.2.")).toBe(true);
    expect(verifyUnsubscribeToken(createKeyRing(2, { 2: b64() }), token)).toBeNull();
  });
});

describe("lien, en-têtes et pied de page", () => {
  it("construit le lien sur le site de l'application", () => {
    expect(unsubscribeUrl("https://app.acme.test/", "tok")).toBe("https://app.acme.test/api/unsubscribe/tok");
  });
  it("en-têtes List-Unsubscribe et One-Click (RFC 8058)", () => {
    expect(listUnsubscribeHeaders("https://app.acme.test/api/unsubscribe/tok")).toEqual([
      { name: "List-Unsubscribe", value: "<https://app.acme.test/api/unsubscribe/tok>" },
      { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
    ]);
  });
  it("le pied de page ajoute le lien après le corps", () => {
    const out = appendUnsubscribeFooter("Bonjour", "https://app.acme.test/api/unsubscribe/tok");
    expect(out.startsWith("Bonjour\n\n--\n")).toBe(true);
    expect(out).toContain("https://app.acme.test/api/unsubscribe/tok");
  });
});
