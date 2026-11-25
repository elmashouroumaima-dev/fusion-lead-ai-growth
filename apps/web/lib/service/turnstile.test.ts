import { describe, expect, it, vi } from "vitest";
import { TURNSTILE_VERIFY_URL, verifyTurnstile } from "./turnstile";

const base = { secret: "secret-de-test-turnstile", token: "jeton-visiteur", ip: "203.0.113.7", origin: "https://exemple.ma" };
const reply = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("verifyTurnstile (S-10)", () => {
  it("ok : succès Cloudflare ET nom d'hôte de l'origine de la clé", async () => {
    const fetchImpl = reply({ success: true, hostname: "exemple.ma" });
    expect(await verifyTurnstile({ ...base, fetchImpl })).toBe("ok");
  });

  it("n'envoie à Cloudflare que le secret, le jeton, l'adresse et une clé d'idempotence (jamais l'origine ni un corps)", async () => {
    const fetchImpl = reply({ success: true, hostname: "exemple.ma" });
    await verifyTurnstile({ ...base, fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TURNSTILE_VERIFY_URL);
    expect(init.method).toBe("POST");
    const sent = new URLSearchParams(String(init.body));
    expect([...sent.keys()].sort()).toEqual(["idempotency_key", "remoteip", "response", "secret"]);
    expect(sent.get("response")).toBe("jeton-visiteur");
    expect(sent.get("remoteip")).toBe("203.0.113.7");
  });

  it("sans adresse lisible : pas de remoteip", async () => {
    const fetchImpl = reply({ success: true, hostname: "exemple.ma" });
    await verifyTurnstile({ ...base, ip: null, fetchImpl });
    const sent = new URLSearchParams(String(((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]).body));
    expect(sent.has("remoteip")).toBe(false);
  });

  it("failed : jeton refusé par Cloudflare", async () => {
    expect(await verifyTurnstile({ ...base, fetchImpl: reply({ success: false, "error-codes": ["invalid-input-response"] }) })).toBe("failed");
  });

  it("failed : défi émis pour un AUTRE site (nom d'hôte différent ou absent)", async () => {
    expect(await verifyTurnstile({ ...base, fetchImpl: reply({ success: true, hostname: "autre.example" }) })).toBe("failed");
    expect(await verifyTurnstile({ ...base, fetchImpl: reply({ success: true }) })).toBe("failed");
  });

  it("failed : origine illisible", async () => {
    expect(await verifyTurnstile({ ...base, origin: "pas une url", fetchImpl: reply({ success: true, hostname: "exemple.ma" }) })).toBe("failed");
  });

  it("unavailable : réseau en panne, erreur 5xx, réponse illisible ou de forme inattendue", async () => {
    expect(await verifyTurnstile({ ...base, fetchImpl: vi.fn(async () => Promise.reject(new Error("réseau"))) })).toBe("unavailable");
    expect(await verifyTurnstile({ ...base, fetchImpl: reply({}, 503) })).toBe("unavailable");
    expect(await verifyTurnstile({ ...base, fetchImpl: vi.fn(async () => new Response("pas du json", { status: 200 })) })).toBe("unavailable");
    expect(await verifyTurnstile({ ...base, fetchImpl: reply({ success: "oui" }) })).toBe("unavailable");
  });

  it("unavailable : Cloudflare trop lent (délai dépassé)", async () => {
    const slow = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("abort")))));
    expect(await verifyTurnstile({ ...base, fetchImpl: slow as unknown as typeof fetch, timeoutMs: 20 })).toBe("unavailable");
  });
});
