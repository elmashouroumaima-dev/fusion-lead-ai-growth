import { beforeEach, describe, expect, it, vi } from "vitest";

const createClient = vi.fn();
const getServerEnv = vi.fn();

vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({ createClient: (...args: unknown[]) => createClient(...args) }));
vi.mock("../env/server", () => ({ getServerEnv: () => getServerEnv() }));

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
    });
  });

  it("une variable manquante (getServerEnv lève) n'est jamais contournée", () => {
    getServerEnv.mockImplementation(() => {
      throw new Error("SUPABASE_SECRET_KEY : manquante");
    });
    expect(() => createAdminClient()).toThrow();
    expect(createClient).not.toHaveBeenCalled();
  });
});
