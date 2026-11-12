import { describe, expect, it, vi } from "vitest";
import { equalsOtherSecret } from "./secret-guard";

const ORG = "bb000000-0000-4000-8000-00000000000a";
const INT = "7a000000-0000-4000-8000-000000000001";
const TOKEN = "jeton-d-envoi-0123456789-abcdefghij";

describe("equalsOtherSecret", () => {
  it("identique : à refuser ; différent ou sans autre secret : permis", async () => {
    expect(await equalsOtherSecret(async () => TOKEN, ORG, INT, TOKEN)).toBe(true);
    expect(await equalsOtherSecret(async () => TOKEN, ORG, INT, `${TOKEN}x`)).toBe(false);
    expect(await equalsOtherSecret(async () => TOKEN, ORG, INT, "")).toBe(false);
    expect(await equalsOtherSecret(async () => null, ORG, INT, TOKEN)).toBe(false);
  });

  it("lit avec l'entreprise et l'intégration données seulement", async () => {
    const read = vi.fn(async () => TOKEN);
    await equalsOtherSecret(read, ORG, INT, "autre-secret-0123456789-abcdefghijklmnop");
    expect(read).toHaveBeenCalledWith(ORG, INT);
  });

  it("une panne de lecture remonte (l'appelant répond 503), jamais « permis »", async () => {
    await expect(equalsOtherSecret(async () => { throw new Error("secrets_unavailable"); }, ORG, INT, TOKEN)).rejects.toThrow("secrets_unavailable");
  });
});
