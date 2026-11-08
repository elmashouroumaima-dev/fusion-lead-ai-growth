import { describe, expect, it } from "vitest";
import { mapProjectsDbError } from "./map-error";

describe("mapProjectsDbError", () => {
  it.each([
    [{ code: "28000", message: "unauthenticated" }, "unauthenticated"],
    [{ code: "PGRST301", message: "JWT expired" }, "unauthenticated"],
    [{ code: "42501", message: "forbidden" }, "forbidden"],
    [{ code: "22023", message: "validation_failed" }, "validation_failed"],
    [{ code: "23514", message: "new row violates check constraint" }, "validation_failed"],
    [{ code: "23503", message: "violates foreign key constraint" }, "validation_failed"],
    [{ code: "PT404", message: "not_found" }, "not_found"],
    [{ code: "P0002", message: "not_found" }, "not_found"],
    [{ code: "P0001", message: "project_archived" }, "conflict"],
    [{ code: "P0001", message: "owner_invalid" }, "validation_failed"],
    [{ code: "P0001", message: "quota_exceeded" }, "quota_exceeded"],
    [{ code: "P0001", message: "subscription_inactive" }, "quota_exceeded"],
    [{ code: "P0001", message: "forbidden" }, "forbidden"],
    [{ code: "XX000", message: "boom" }, "internal_error"],
    [{ code: "P0001", message: "inconnu" }, "internal_error"],
    [null, "internal_error"],
    [undefined, "internal_error"],
  ] as const)("%j -> %s", (error, expected) => {
    expect(mapProjectsDbError(error)).toBe(expected);
  });

  it("ne renvoie jamais le message SQL", () => {
    const result = mapProjectsDbError({ code: "XX000", message: "relation public.projects secret" });
    expect(result).toBe("internal_error");
  });
});
