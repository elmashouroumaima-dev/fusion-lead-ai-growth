import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = {
  signUp: vi.fn(),
  signInWithPassword: vi.fn(),
  signOut: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  updateUser: vi.fn(),
  getSession: vi.fn(),
  getClaims: vi.fn(),
};
const cookieDelete = vi.fn();
const cookieGet = vi.fn();

class RedirectSignal extends Error {
  constructor(public readonly url: string) {
    super("NEXT_REDIRECT");
  }
}

vi.mock("../supabase/server", () => ({ createClient: async () => ({ auth }) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ delete: cookieDelete, get: cookieGet }) }));
vi.mock("./site-url", () => ({ getSiteUrl: () => "http://127.0.0.1:3000" }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));

import {
  requestPasswordResetAction,
  signInAction,
  signOutAction,
  signUpAction,
  updatePasswordAction,
} from "./actions";
import type { AuthActionState } from "./types";

const IDLE: AuthActionState = { status: "idle" };
const PASSWORD = "S3cret-Passw0rd!";
const EMAIL = "victim@example.test";

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

async function redirectOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RedirectSignal) return e.url;
    throw e;
  }
  throw new Error("redirect attendu mais non levé");
}

beforeEach(() => {
  for (const fn of Object.values(auth)) fn.mockReset();
  cookieDelete.mockReset();
  cookieGet.mockReset();
  cookieGet.mockImplementation((name: string) => (name === "fl_recovery" ? { name, value: "1" } : undefined));
  auth.getClaims.mockResolvedValue({ data: { claims: { sub: "u1", amr: [{ method: "otp" }] } }, error: null });
  auth.signUp.mockResolvedValue({ data: {}, error: null });
  auth.signInWithPassword.mockResolvedValue({ data: {}, error: null });
  auth.signOut.mockResolvedValue({ error: null });
  auth.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
  auth.updateUser.mockResolvedValue({ data: {}, error: null });
});

describe("signInAction", () => {
  const valid = { email: EMAIL, password: PASSWORD, locale: "en" };

  it("entrée invalide -> invalid_input + fieldErrors, sans appeler Supabase", async () => {
    const res = await signInAction(IDLE, form({ email: "pas-un-email", password: "", locale: "en" }));
    expect(res.status).toBe("error");
    expect(res.code).toBe("invalid_input");
    expect(Object.keys(res.fieldErrors ?? {}).sort()).toEqual(["email", "password"]);
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("locale hors liste -> invalid_input (pas de redirection vers une locale arbitraire)", async () => {
    const res = await signInAction(IDLE, form({ ...valid, locale: "../evil" }));
    expect(res.code).toBe("invalid_input");
    expect(res.fieldErrors).toHaveProperty("locale");
  });

  it("mauvais mot de passe et compte inconnu donnent EXACTEMENT le même résultat", async () => {
    // GoTrue renvoie le même code dans les deux cas ; l'action ne doit pas les distinguer.
    auth.signInWithPassword.mockResolvedValueOnce({
      data: {},
      error: { code: "invalid_credentials", status: 400, message: "Invalid login credentials" },
    });
    const wrongPassword = await signInAction(IDLE, form(valid));
    auth.signInWithPassword.mockResolvedValueOnce({
      data: {},
      error: { code: "invalid_credentials", status: 400, message: "Invalid login credentials" },
    });
    const unknownAccount = await signInAction(IDLE, form({ ...valid, email: "nobody@example.test" }));
    expect(wrongPassword).toEqual(unknownAccount);
    expect(wrongPassword).toEqual({ status: "error", code: "invalid_credentials" });
  });

  it("l'ancien code invalid_login_credentials est aussi uniformisé", async () => {
    auth.signInWithPassword.mockResolvedValueOnce({ data: {}, error: { code: "invalid_login_credentials", status: 400 } });
    expect(await signInAction(IDLE, form(valid))).toEqual({ status: "error", code: "invalid_credentials" });
  });

  it("jamais de mot de passe ni d'e-mail dans l'état renvoyé (erreur Supabase bavarde incluse)", async () => {
    auth.signInWithPassword.mockResolvedValueOnce({
      data: {},
      error: { code: "weird", status: 500, message: `failed for ${EMAIL} with ${PASSWORD}` },
    });
    const bad = await signInAction(IDLE, form(valid));
    const invalid = await signInAction(IDLE, form({ ...valid, email: "bad", password: PASSWORD }));
    for (const res of [bad, invalid]) {
      const json = JSON.stringify(res);
      expect(json).not.toContain(PASSWORD);
      expect(json).not.toContain(EMAIL);
      expect(json).not.toContain("example.test");
    }
    expect(bad).toEqual({ status: "error", code: "generic" });
  });

  it("l'état ne contient que des codes, jamais de champ message", async () => {
    auth.signInWithPassword.mockResolvedValueOnce({ data: {}, error: { code: "email_not_confirmed", status: 400, message: "Email not confirmed" } });
    const res = await signInAction(IDLE, form(valid));
    expect(res).toEqual({ status: "error", code: "email_not_confirmed" });
    expect(res).not.toHaveProperty("message");
  });

  it("succès -> redirection vers le tableau de bord de la locale", async () => {
    expect(await redirectOf(signInAction(IDLE, form(valid)))).toBe("/en/dashboard");
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD });
  });

  it("succès avec next interne valide -> redirigé vers next", async () => {
    expect(await redirectOf(signInAction(IDLE, form({ ...valid, next: "/en/leads?tab=1" })))).toBe("/en/leads?tab=1");
  });

  it.each(["//evil.com", "https://evil.com", String.raw`/\evil.com`, "javascript:alert(1)", "/%2F%2Fevil.com"])(
    "succès avec next hostile %s -> repli sûr",
    async (next) => {
      expect(await redirectOf(signInAction(IDLE, form({ ...valid, locale: "ar", next })))).toBe("/ar/dashboard");
    },
  );

  it("normalise l'e-mail avant l'appel Supabase", async () => {
    await redirectOf(signInAction(IDLE, form({ ...valid, email: "  VICTIM@Example.TEST " })));
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD });
  });
});

describe("signUpAction", () => {
  const valid = { email: EMAIL, password: PASSWORD, locale: "ar" };

  it("mot de passe de 9 caractères -> invalid_input (borne) ; 10 -> accepté", async () => {
    const short = await signUpAction(IDLE, form({ ...valid, password: "x".repeat(9) }));
    expect(short.code).toBe("invalid_input");
    expect(short.fieldErrors).toHaveProperty("password");
    expect(auth.signUp).not.toHaveBeenCalled();
    const ok = await signUpAction(IDLE, form({ ...valid, password: "x".repeat(10) }));
    expect(ok).toEqual({ status: "success" });
  });

  it("emailRedirectTo vient du serveur, pas du client", async () => {
    await signUpAction(IDLE, form({ ...valid, next: "https://evil.com", emailRedirectTo: "https://evil.com/phish" }));
    const arg = auth.signUp.mock.calls[0]![0];
    expect(arg.options.emailRedirectTo).toBe("http://127.0.0.1:3000/auth/confirm");
    expect(JSON.stringify(arg)).not.toContain("evil.com");
  });

  it("e-mail déjà inscrit (succès GoTrue anti-énumération) -> même succès générique", async () => {
    const fresh = await signUpAction(IDLE, form(valid));
    auth.signUp.mockResolvedValueOnce({ data: { user: { identities: [] } }, error: null });
    const existing = await signUpAction(IDLE, form(valid));
    expect(existing).toEqual(fresh);
    expect(fresh).toEqual({ status: "success" });
  });

  it("mot de passe faible côté Supabase -> weak_password sans fuite", async () => {
    auth.signUp.mockResolvedValueOnce({ data: {}, error: { code: "weak_password", status: 422, message: `pwd ${PASSWORD}` } });
    const res = await signUpAction(IDLE, form(valid));
    expect(res).toEqual({ status: "error", code: "weak_password" });
    expect(JSON.stringify(res)).not.toContain(PASSWORD);
  });

  it("limite de débit -> rate_limited (par code et par statut 429)", async () => {
    auth.signUp.mockResolvedValueOnce({ data: {}, error: { code: "over_email_send_rate_limit", status: 429 } });
    expect((await signUpAction(IDLE, form(valid))).code).toBe("rate_limited");
    auth.signUp.mockResolvedValueOnce({ data: {}, error: { status: 429 } });
    expect((await signUpAction(IDLE, form(valid))).code).toBe("rate_limited");
  });
});

describe("requestPasswordResetAction", () => {
  const valid = { email: "unknown@example.test", locale: "en" };

  it("succès générique même pour un e-mail inconnu / erreur serveur (anti-énumération)", async () => {
    const ok = await requestPasswordResetAction(IDLE, form(valid));
    auth.resetPasswordForEmail.mockResolvedValueOnce({ data: null, error: { code: "user_not_found", status: 400, message: "User not found" } });
    const unknown = await requestPasswordResetAction(IDLE, form(valid));
    auth.resetPasswordForEmail.mockResolvedValueOnce({ data: null, error: { code: "unexpected_failure", status: 500 } });
    const broken = await requestPasswordResetAction(IDLE, form(valid));
    expect(unknown).toEqual(ok);
    expect(broken).toEqual(ok);
    expect(ok).toEqual({ status: "success" });
  });

  it("seule la limite de débit est exposée", async () => {
    auth.resetPasswordForEmail.mockResolvedValueOnce({ data: null, error: { code: "over_email_send_rate_limit", status: 429 } });
    expect(await requestPasswordResetAction(IDLE, form(valid))).toEqual({ status: "error", code: "rate_limited" });
  });

  it("redirectTo fixé côté serveur", async () => {
    await requestPasswordResetAction(IDLE, form({ ...valid, redirectTo: "https://evil.com" }));
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith("unknown@example.test", {
      redirectTo: "http://127.0.0.1:3000/auth/confirm",
    });
  });

  it("e-mail invalide -> invalid_input sans appel Supabase", async () => {
    const res = await requestPasswordResetAction(IDLE, form({ email: "nope", locale: "en" }));
    expect(res.code).toBe("invalid_input");
    expect(auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });
});

describe("signOutAction", () => {
  it("utilise scope 'local', efface le cookie de récupération et redirige vers /{locale}/login", async () => {
    const url = await redirectOf(signOutAction(IDLE, form({ locale: "ar" })));
    expect(url).toBe("/ar/login");
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(cookieDelete).toHaveBeenCalledWith("fl_recovery");
  });

  it("locale invalide -> invalid_input, aucune déconnexion ni redirection", async () => {
    const res = await signOutAction(IDLE, form({ locale: "xx" }));
    expect(res.code).toBe("invalid_input");
    expect(auth.signOut).not.toHaveBeenCalled();
  });
});

describe("updatePasswordAction", () => {
  const valid = { password: PASSWORD, locale: "en" };

  it("succès : met à jour, invalide les AUTRES sessions, consomme le cookie de récupération", async () => {
    expect(await updatePasswordAction(IDLE, form(valid))).toEqual({ status: "success" });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: PASSWORD });
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "others" });
    expect(cookieDelete).toHaveBeenCalledWith("fl_recovery");
  });

  it("SANS cookie de récupération -> generic, rien n'est modifié ni invalidé", async () => {
    cookieGet.mockReturnValue(undefined);
    const res = await updatePasswordAction(IDLE, form(valid));
    expect(res).toEqual({ status: "error", code: "generic" });
    expect(auth.updateUser).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("cookie de récupération à une valeur autre que 1 -> refusé", async () => {
    cookieGet.mockReturnValue({ name: "fl_recovery", value: "0" });
    expect((await updatePasswordAction(IDLE, form(valid))).code).toBe("generic");
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("cookie présent mais claims invalides -> refusé", async () => {
    auth.getClaims.mockResolvedValueOnce({ data: null, error: new Error("jwt") });
    expect((await updatePasswordAction(IDLE, form(valid))).code).toBe("generic");
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("session ouverte par mot de passe (amr=password) + cookie forgé -> refusé", async () => {
    auth.getClaims.mockResolvedValueOnce({ data: { claims: { sub: "u1", amr: [{ method: "password" }] } }, error: null });
    expect((await updatePasswordAction(IDLE, form(valid))).code).toBe("generic");
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("amr absent : on s'en remet au cookie (champ non garanti)", async () => {
    auth.getClaims.mockResolvedValueOnce({ data: { claims: { sub: "u1" } }, error: null });
    expect(await updatePasswordAction(IDLE, form(valid))).toEqual({ status: "success" });
  });

  it("échec de updateUser : le cookie de récupération n'est PAS consommé", async () => {
    auth.updateUser.mockResolvedValueOnce({ data: {}, error: { code: "weak_password", status: 422, message: "x" } });
    await updatePasswordAction(IDLE, form(valid));
    expect(cookieDelete).not.toHaveBeenCalled();
  });

  it("mot de passe trop court -> invalid_input, rien n'est modifié", async () => {
    const res = await updatePasswordAction(IDLE, form({ ...valid, password: "x".repeat(9) }));
    expect(res.code).toBe("invalid_input");
    expect(auth.updateUser).not.toHaveBeenCalled();
    expect(JSON.stringify(res)).not.toContain("xxxxxxxxx");
  });

  it("échec Supabase (session absente) : erreur sans nettoyage de session ni fuite", async () => {
    auth.updateUser.mockResolvedValueOnce({ data: {}, error: { code: "session_not_found", status: 403, message: `no session ${PASSWORD}` } });
    const res = await updatePasswordAction(IDLE, form(valid));
    expect(res).toEqual({ status: "error", code: "generic" });
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(JSON.stringify(res)).not.toContain(PASSWORD);
  });
});

describe("garde transversale", () => {
  it("aucune action n'appelle getSession", async () => {
    await signUpAction(IDLE, form({ email: EMAIL, password: PASSWORD, locale: "en" }));
    await requestPasswordResetAction(IDLE, form({ email: EMAIL, locale: "en" }));
    await updatePasswordAction(IDLE, form({ password: PASSWORD, locale: "en" }));
    await redirectOf(signInAction(IDLE, form({ email: EMAIL, password: PASSWORD, locale: "en" })));
    await redirectOf(signOutAction(IDLE, form({ locale: "en" })));
    expect(auth.getSession).not.toHaveBeenCalled();
  });

  it("champs hors liste ignorés : organization_id / role ne parviennent jamais à Supabase", async () => {
    await signUpAction(IDLE, form({ email: EMAIL, password: PASSWORD, locale: "en", organization_id: "o1", role: "owner" }));
    const arg = auth.signUp.mock.calls[0]![0];
    expect(Object.keys(arg).sort()).toEqual(["email", "options", "password"]);
    expect(Object.keys(arg.options)).toEqual(["emailRedirectTo"]);
  });
});
