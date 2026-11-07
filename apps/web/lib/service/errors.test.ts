import { describe, expect, it } from "vitest";
import { errorResponse, normalizeError, ServiceError, serviceErrorStatus, type ServiceErrorCode } from "./errors";

const TABLE: ReadonlyArray<readonly [ServiceErrorCode, number]> = [
  ["unauthenticated", 401],
  ["forbidden", 403],
  ["validation_failed", 400],
  ["not_found", 404],
  ["idempotency_conflict", 422],
  ["idempotency_in_progress", 409],
  ["duplicate_request", 409],
  ["rate_limited", 429],
  ["payload_too_large", 413],
  ["quota_exceeded", 429],
  ["service_unavailable", 503],
  ["internal_error", 500],
];

describe("ServiceError / normalizeError", () => {
  it.each(TABLE)("%s -> %i avec corps { code, message, request_id } et écho de l'en-tête", async (code, status) => {
    const error = new ServiceError(code);
    expect(error.status).toBe(status);
    expect(serviceErrorStatus(code)).toBe(status);
    const res = errorResponse(error, "req-12345678");
    expect(res.status).toBe(status);
    expect(res.headers.get("x-request-id")).toBe("req-12345678");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ code, message: expect.any(String), request_id: "req-12345678" });
  });

  it("le message est le texte générique du code, jamais un texte brut", () => {
    const { body } = normalizeError(new ServiceError("forbidden"), "req-12345678");
    expect(body.message).toBe("You are not allowed to perform this action.");
  });

  it("une erreur inconnue devient internal_error sans recopier son message ni sa pile", () => {
    const { status, body } = normalizeError(new Error("duplicate key value violates organizations_slug_key"), "req-12345678");
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("duplicate");
    expect(body.code).toBe("internal_error");
    expect(normalizeError("texte brut", "req-12345678").body.code).toBe("internal_error");
    expect(normalizeError(undefined, "req-12345678").body.code).toBe("internal_error");
  });

  it("Retry-After n'est posé que pour un nombre entier de secondes strictement positif", () => {
    expect(normalizeError(new ServiceError("rate_limited", { retryAfterSeconds: 7 }), "r").headers["retry-after"]).toBe("7");
    expect(normalizeError(new ServiceError("rate_limited", { retryAfterSeconds: 0 }), "r").headers["retry-after"]).toBeUndefined();
    expect(normalizeError(new ServiceError("rate_limited", { retryAfterSeconds: 1.5 }), "r").headers["retry-after"]).toBeUndefined();
    expect(normalizeError(new ServiceError("forbidden"), "r").headers["retry-after"]).toBeUndefined();
  });

  it("duplicate_request signale le rejeu par l'en-tête Idempotent-Replay", () => {
    expect(normalizeError(new ServiceError("duplicate_request"), "r").headers["idempotent-replay"]).toBe("true");
    expect(normalizeError(new ServiceError("forbidden"), "r").headers["idempotent-replay"]).toBeUndefined();
  });

  it("les erreurs de champ ne sortent jamais dans le corps HTTP", () => {
    const error = new ServiceError("validation_failed", { fieldErrors: { email: ["invalid_format"] } });
    expect(JSON.stringify(normalizeError(error, "r").body)).not.toContain("email");
  });
});
