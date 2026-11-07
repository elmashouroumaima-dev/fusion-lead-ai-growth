import { describe, expect, it } from "vitest";
import { apiError } from "./errors";
import { getRequestId } from "./request-id";

describe("getRequestId", () => {
  it("reprend un x-request-id sûr", () => {
    expect(getRequestId(new Headers({ "x-request-id": "req-12345678" }))).toBe("req-12345678");
  });
  it.each(["short", "has space in it", "x".repeat(129), "a\r\nb-injected-header"])("remplace %j par un uuid", (value) => {
    const headers = { get: () => value };
    expect(getRequestId(headers)).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("génère un uuid sans en-tête", () => {
    expect(getRequestId(new Headers())).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("apiError", () => {
  it.each([
    ["unauthenticated", 401],
    ["forbidden", 403],
    ["validation_failed", 400],
    ["idempotency_conflict", 422],
    ["payload_too_large", 413],
    ["internal_error", 500],
  ] as const)("%s -> %i avec corps { code, message, request_id } et écho de l'en-tête", async (code, status) => {
    const res = apiError(code, "req-12345678");
    expect(res.status).toBe(status);
    expect(res.headers.get("x-request-id")).toBe("req-12345678");
    expect(await res.json()).toEqual({ code, message: expect.any(String), request_id: "req-12345678" });
  });
});
