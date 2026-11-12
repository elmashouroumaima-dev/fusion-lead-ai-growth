import { beforeEach, describe, expect, it, vi } from "vitest";

const createServerClient = vi.fn();

vi.mock("@supabase/ssr", () => ({ createServerClient: (...args: unknown[]) => createServerClient(...args) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: vi.fn() }) }));
vi.mock("../env/client", () => ({
  getClientEnv: () => ({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_0123456789" }),
}));

import { runWithRequestContext } from "../service/request-context";
import { createClient } from "./server";

type Options = { global?: { headers?: Record<string, string> } };
const lastOptions = (): Options => (createServerClient.mock.calls.at(-1)?.[2] ?? {}) as Options;

beforeEach(() => {
  vi.clearAllMocks();
  createServerClient.mockReturnValue({});
});

describe("createClient (serveur) : en-tête x-request-id", () => {
  it("envoie le request_id serveur du contexte de requête sur chaque requête Supabase", async () => {
    await runWithRequestContext({ requestId: "0f8fad5b-d9cb-469f-a165-70867728950e" }, () => createClient());
    expect(lastOptions().global?.headers).toEqual({ "x-request-id": "0f8fad5b-d9cb-469f-a165-70867728950e" });
  });

  it("hors contexte de requête : aucun en-tête x-request-id", async () => {
    await createClient();
    expect(lastOptions().global?.headers).toEqual({});
  });

  it("deux requêtes concurrentes : chaque client porte SON identifiant", async () => {
    await Promise.all([
      runWithRequestContext({ requestId: "req-aaaaaaaa" }, async () => {
        await new Promise((r) => setTimeout(r, 3));
        await createClient();
      }),
      runWithRequestContext({ requestId: "req-bbbbbbbb" }, () => createClient()),
    ]);
    const ids = createServerClient.mock.calls.map((c) => (c[2] as Options).global?.headers?.["x-request-id"]).sort();
    expect(ids).toEqual(["req-aaaaaaaa", "req-bbbbbbbb"]);
  });

  it("la clé et l'URL restent celles de l'environnement public (clé publishable)", async () => {
    await createClient();
    expect(createServerClient.mock.calls[0]?.[0]).toBe("http://127.0.0.1:54321");
    expect(createServerClient.mock.calls[0]?.[1]).toBe("sb_publishable_test_0123456789");
  });
});
