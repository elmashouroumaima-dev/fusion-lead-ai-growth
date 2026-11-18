import { describe, expect, it, vi } from "vitest";
import { createPostmarkValidator, POSTMARK_SERVER_URL } from "./postmark-validate";

const TOKEN = "pm-SECRET-TOKEN-0123456789abcdef";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("validation du jeton Postmark", () => {
  it("jeton accepté : une seule requête GET vers l'adresse FIXE, le jeton dans l'en-tête du serveur, aucune redirection suivie", async () => {
    const fetchMock = vi.fn(async () => json(200, { ID: 123, Name: "Serveur de test" }));
    expect(await createPostmarkValidator({ fetch: fetchMock as never }).validate({ serverToken: TOKEN })).toEqual({ kind: "valid" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(POSTMARK_SERVER_URL);
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>)["X-Postmark-Server-Token"]).toBe(TOKEN);
    expect(String(url)).not.toContain(TOKEN);
  });

  it("jeton refusé (401 ou 403) : provider_auth", async () => {
    for (const status of [401, 403]) {
      const fetchMock = vi.fn(async () => json(status, { ErrorCode: 10, Message: "Bad or missing API token" }));
      expect(await createPostmarkValidator({ fetch: fetchMock as never }).validate({ serverToken: TOKEN })).toEqual({ kind: "invalid", code: "provider_auth" });
    }
  });

  it("panne, limite ou délai dépassé : provider_unavailable (l'intégration n'est jamais dégradée pour cela)", async () => {
    for (const status of [429, 500, 502, 503]) {
      const fetchMock = vi.fn(async () => json(status, {}));
      expect(await createPostmarkValidator({ fetch: fetchMock as never }).validate({ serverToken: TOKEN })).toEqual({ kind: "invalid", code: "provider_unavailable" });
    }
    const failing = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await createPostmarkValidator({ fetch: failing as never }).validate({ serverToken: TOKEN })).toEqual({ kind: "invalid", code: "provider_unavailable" });
  });

  it("réponse inexploitable : provider_unreadable (200 sans identifiant, corps illisible, statut inattendu)", async () => {
    const cases = [() => json(200, {}), () => new Response("pas du json", { status: 200 }), () => json(404, {}), () => json(422, {})];
    for (const make of cases) {
      const fetchMock = vi.fn(async () => make());
      expect(await createPostmarkValidator({ fetch: fetchMock as never }).validate({ serverToken: TOKEN })).toEqual({ kind: "invalid", code: "provider_unreadable" });
    }
  });

  it("un jeton vide, trop long ou avec un caractère de contrôle n'est jamais envoyé", async () => {
    const fetchMock = vi.fn(async () => json(200, { ID: 1 }));
    const validator = createPostmarkValidator({ fetch: fetchMock as never });
    for (const bad of ["", "a".repeat(4097), "jeton\nsuite", "jeton\u0000"]) {
      expect(await validator.validate({ serverToken: bad })).toEqual({ kind: "invalid", code: "provider_auth" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("le texte du fournisseur n'est jamais recopié dans le résultat", async () => {
    const fetchMock = vi.fn(async () => json(401, { Message: `jeton ${TOKEN} refusé pour ventes@exemple.com` }));
    const result = await createPostmarkValidator({ fetch: fetchMock as never }).validate({ serverToken: TOKEN });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain("exemple.com");
  });
});
