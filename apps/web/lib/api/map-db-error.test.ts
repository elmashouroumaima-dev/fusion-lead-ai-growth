import { describe, expect, it } from "vitest";
import { mapDbError } from "./map-db-error";

describe("mapDbError", () => {
  it.each([
    [{ code: "P0001", message: "idempotency_conflict" }, "idempotency_conflict"],
    [{ code: "22023", message: "validation_failed" }, "validation_failed"],
    [{ code: "28000", message: "unauthenticated" }, "unauthenticated"],
    [{ message: "unauthenticated" }, "unauthenticated"],
    [{ code: "42501", message: "permission denied for function create_organization" }, "forbidden"],
    [{ code: "PGRST301", message: "JWT expired" }, "unauthenticated"],
    [{ code: "22023", message: "autre" }, "validation_failed"],
  ] as const)("%j -> %s", (error, expected) => {
    expect(mapDbError(error)).toBe(expected);
  });

  it.each([
    [null],
    [undefined],
    [{}],
    [{ code: "P0001", message: "something else raised by another function" }],
    [{ code: "23505", message: 'duplicate key value violates unique constraint "organizations_slug_key"' }],
    [{ code: "XX000", message: "idempotency_conflict" }],
  ])("%j -> internal_error (jamais le message SQL)", (error) => {
    expect(mapDbError(error)).toBe("internal_error");
  });
});
