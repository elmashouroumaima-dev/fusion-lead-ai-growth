import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import fr from "../../messages/fr.json";
import type { ServiceErrorCode } from "./errors";
import { serviceCodeToFormCode } from "./form";

/**
 * J11 : chaque code de la couche service qui peut atteindre un formulaire doit avoir un message
 * fr / ar / en non vide, naturel (pas une copie de l'anglais) et sans variable ICU inattendue.
 */
type Dict = Record<string, unknown>;
const get = (root: unknown, path: string): unknown => path.split(".").reduce<unknown>((acc, k) => (acc as Dict | undefined)?.[k], root);

const NEW_KEYS = [
  "Auth.errors.rate_limited",
  "Org.errors.rate_limited",
  "Org.errors.duplicate_request",
  "Org.errors.idempotency_in_progress",
  "Org.errors.service_unavailable",
  "Members.errors.rate_limited",
  "Members.errors.duplicate_request",
  "Members.errors.idempotency_in_progress",
  "Members.errors.service_unavailable",
  "Members.errors.idempotency_conflict",
] as const;

const LOCALES = { fr, ar, en } as const;

describe("messages J11 : parité fr / ar / en", () => {
  it.each(NEW_KEYS)("%s existe, non vide, dans les trois langues", (key) => {
    for (const [name, dict] of Object.entries(LOCALES)) {
      const value = get(dict, key);
      expect(typeof value, `${name}:${key}`).toBe("string");
      expect((value as string).trim().length, `${name}:${key}`).toBeGreaterThan(10);
    }
  });

  it.each(NEW_KEYS)("%s : fr et ar traduits (différents de l'anglais) et différents entre eux", (key) => {
    const [f, a, e] = [get(fr, key), get(ar, key), get(en, key)] as string[];
    expect(f).not.toBe(e);
    expect(a).not.toBe(e);
    expect(a).not.toBe(f);
  });

  it.each(NEW_KEYS)("%s : arabe en écriture arabe, sans HTML ni variable ICU", (key) => {
    const a = get(ar, key) as string;
    expect(a).toMatch(/[؀-ۿ]/);
    for (const dict of Object.values(LOCALES)) {
      const v = get(dict, key) as string;
      expect(v).not.toMatch(/[<>{}]/);
      expect(v).not.toMatch(/\b(undefined|null|TODO|lorem)\b/i);
    }
  });

  it.each(NEW_KEYS)("%s : ne fuit pas de détail technique (SQL, 429, Postgres, clé)", (key) => {
    for (const dict of Object.values(LOCALES)) {
      expect(get(dict, key) as string).not.toMatch(/postgres|sql|\b429\b|\b503\b|service_role|idempotency-key/i);
    }
  });
});

describe("tout code service atteignant un formulaire Membres a un message traduit", () => {
  const CODES: ServiceErrorCode[] = [
    "unauthenticated",
    "forbidden",
    "validation_failed",
    "not_found",
    "idempotency_conflict",
    "idempotency_in_progress",
    "duplicate_request",
    "rate_limited",
    "payload_too_large",
    "quota_exceeded",
    "service_unavailable",
    "internal_error",
  ];
  it.each(CODES)("serviceCodeToFormCode(%s) -> clé Members.errors.* et Org.errors.* présentes en fr, ar et en", (code) => {
    const mapped = serviceCodeToFormCode(code);
    for (const [name, dict] of Object.entries(LOCALES)) {
      expect(typeof get(dict, `Members.errors.${mapped}`), `${name}:Members:${mapped}`).toBe("string");
      expect(typeof get(dict, `Org.errors.${mapped}`), `${name}:Org:${mapped}`).toBe("string");
    }
  });

  it("duplicate_request et idempotency_in_progress sont DISTINCTS (messages différents), tout comme la limite et generic", () => {
    expect(serviceCodeToFormCode("duplicate_request")).toBe("duplicate_request");
    expect(serviceCodeToFormCode("idempotency_in_progress")).toBe("idempotency_in_progress");
    expect(serviceCodeToFormCode("rate_limited")).toBe("rate_limited");
    expect(serviceCodeToFormCode("quota_exceeded")).toBe("rate_limited");
    expect(serviceCodeToFormCode("service_unavailable")).toBe("service_unavailable");
    expect(serviceCodeToFormCode("unauthenticated")).toBe("forbidden");
    expect(serviceCodeToFormCode("internal_error")).toBe("generic");
    for (const [name, dict] of Object.entries(LOCALES)) {
      for (const ns of ["Members", "Org"]) {
        expect(get(dict, `${ns}.errors.duplicate_request`), `${name}:${ns}`).not.toBe(get(dict, `${ns}.errors.idempotency_in_progress`));
      }
    }
  });

  it("Auth.errors.service_unavailable (clé morte) a été retirée des trois langues", () => {
    for (const [name, dict] of Object.entries(LOCALES)) expect(get(dict, "Auth.errors.service_unavailable"), name).toBeUndefined();
  });
});
