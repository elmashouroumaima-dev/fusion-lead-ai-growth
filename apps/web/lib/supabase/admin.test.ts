import { beforeEach, describe, expect, it, vi } from "vitest";

const createClient = vi.fn();
const getServerEnv = vi.fn();

vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({ createClient: (...args: unknown[]) => createClient(...args) }));
vi.mock("../env/server", () => ({ getServerEnv: () => getServerEnv() }));

import { runWithRequestContext } from "../service/request-context";
import { createAdminClient } from "./admin";

beforeEach(() => {
  vi.clearAllMocks();
  createClient.mockReturnValue({ rpc: vi.fn() });
  getServerEnv.mockReturnValue({ SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SECRET_KEY: "sb_secret_0123456789abcdefghij" });
});

describe("createAdminClient", () => {
  it("utilise l'URL et la clé secrète de l'environnement serveur validé, sans session persistée", () => {
    createAdminClient();
    expect(createClient).toHaveBeenCalledWith("http://127.0.0.1:54321", "sb_secret_0123456789abcdefghij", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: {} },
    });
  });

  it("dans un contexte de requête : envoie x-request-id (identifiant serveur) sur chaque requête", () => {
    runWithRequestContext({ requestId: "0f8fad5b-d9cb-469f-a165-70867728950e" }, () => createAdminClient());
    const options = createClient.mock.calls[0]?.[2] as { global: { headers: Record<string, string> } };
    expect(options.global.headers).toEqual({ "x-request-id": "0f8fad5b-d9cb-469f-a165-70867728950e" });
  });

  it("une variable manquante (getServerEnv lève) n'est jamais contournée", () => {
    getServerEnv.mockImplementation(() => {
      throw new Error("SUPABASE_SECRET_KEY : manquante");
    });
    expect(() => createAdminClient()).toThrow();
    expect(createClient).not.toHaveBeenCalled();
  });
});
