import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { generateInvitationToken, hashInvitationToken } from "./token";

describe("jeton d'invitation : entropie et empreinte", () => {
  const sample = Array.from({ length: 1000 }, () => generateInvitationToken());

  it("1000 jetons tous distincts, 1000 empreintes toutes distinctes", () => {
    expect(new Set(sample.map((s) => s.token)).size).toBe(1000);
    expect(new Set(sample.map((s) => s.tokenHash)).size).toBe(1000);
  });

  it("chaque jeton : 43 caractères base64url sans remplissage ; chaque empreinte : 64 hex minuscules", () => {
    for (const { token, tokenHash } of sample) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("l'empreinte est le sha256 hex du jeton (calcul indépendant) et le jeton n'est jamais égal à son empreinte", () => {
    for (const { token, tokenHash } of sample) {
      expect(tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
      expect(token).not.toBe(tokenHash);
      expect(tokenHash).not.toContain(token);
    }
  });

  it("hashInvitationToken est stable (déterministe) et sensible au moindre changement", () => {
    const { token } = sample[0] as { token: string };
    expect(hashInvitationToken(token)).toBe(hashInvitationToken(token));
    expect(hashInvitationToken(token)).not.toBe(hashInvitationToken(token + "A"));
    expect(hashInvitationToken(token)).not.toBe(hashInvitationToken(token.toLowerCase() === token ? token.toUpperCase() : token.toLowerCase()));
    expect(hashInvitationToken("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("répartition plausible des octets : les 43 positions varient (pas de préfixe ni suffixe constant)", () => {
    for (let i = 0; i < 42; i++) {
      expect(new Set(sample.map((s) => s.token[i])).size, `position ${i}`).toBeGreaterThan(8);
    }
    // 43e caractère : 4 bits de bourrage -> 16 valeurs possibles
    expect(new Set(sample.map((s) => s.token[42])).size).toBeGreaterThan(8);
  });

  it("utilise le CSPRNG : randomBytes(32) est appelé, pas Math.random", async () => {
    vi.resetModules();
    const mathRandom = vi.spyOn(Math, "random");
    const mod = await import("./token");
    mod.generateInvitationToken();
    expect(mathRandom).not.toHaveBeenCalled();
    mathRandom.mockRestore();
  });
});
