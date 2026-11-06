import { describe, expect, it } from "vitest";
import { apiErrorStatus, type ApiErrorCode } from "./errors";
import { mapDbError, type DbErrorLike } from "./map-db-error";

type Row = [label: string, error: DbErrorLike | null | undefined, expected: ApiErrorCode];

const table: Row[] = [
  ["conflit d'idempotence (contrat A2)", { code: "P0001", message: "idempotency_conflict" }, "idempotency_conflict"],
  ["conflit avec espaces autour du message", { code: "P0001", message: "  idempotency_conflict \n" }, "idempotency_conflict"],
  ["validation (contrat A2)", { code: "22023", message: "validation_failed" }, "validation_failed"],
  ["validation sans SQLSTATE", { message: "validation_failed" }, "validation_failed"],
  ["validation, autre message mais 22023", { code: "22023", message: "invalid_parameter_value" }, "validation_failed"],
  ["texte non encodable (22P05)", { code: "22P05", message: "unicode escape" }, "validation_failed"],
  ["caractère hors répertoire (22021)", { code: "22021", message: "invalid byte sequence for encoding" }, "validation_failed"],
  ["non authentifié (contrat A2)", { code: "28000", message: "unauthenticated" }, "unauthenticated"],
  ["non authentifié sans SQLSTATE", { message: "unauthenticated" }, "unauthenticated"],
  ["28000 avec un autre message", { code: "28000", message: "invalid_authorization_specification" }, "unauthenticated"],
  ["JWT expiré", { code: "PGRST301", message: "JWT expired" }, "unauthenticated"],
  ["JWT invalide", { code: "PGRST303", message: "JWT invalid" }, "unauthenticated"],
  ["privilège insuffisant", { code: "42501", message: "permission denied for schema private" }, "forbidden"],
  ["violation d'unicité", { code: "23505", message: 'duplicate key value violates unique constraint "organizations_slug_key"' }, "internal_error"],
  ["clé étrangère", { code: "23503", message: "violates foreign key constraint" }, "internal_error"],
  ["plan trial manquant", { code: "XX000", message: "trial_plan_missing" }, "internal_error"],
  ["uuid invalide (sub vide)", { code: "22P02", message: "invalid input syntax for type uuid" }, "internal_error"],
  ["P0001 avec un autre message", { code: "P0001", message: "anything else" }, "internal_error"],
  ["message conflit avec un autre SQLSTATE", { code: "XX000", message: "idempotency_conflict" }, "internal_error"],
  ["message conflit sans SQLSTATE", { message: "idempotency_conflict" }, "internal_error"],
  ["PGRST non listé", { code: "PGRST116", message: "no rows" }, "internal_error"],
  ["objet vide", {}, "internal_error"],
  ["code et message null", { code: null, message: null }, "internal_error"],
  ["null", null, "internal_error"],
  ["undefined", undefined, "internal_error"],
];

describe("mapDbError (table)", () => {
  it.each(table)("%s", (_label, error, expected) => {
    expect(mapDbError(error)).toBe(expected);
  });

  it("est pure : mêmes entrées -> mêmes sorties, l'entrée n'est pas modifiée", () => {
    const error = { code: "P0001", message: "idempotency_conflict" };
    const copy = { ...error };
    expect(mapDbError(error)).toBe(mapDbError(error));
    expect(error).toEqual(copy);
  });

  it("le résultat appartient toujours au jeu de codes de l'API (statut HTTP défini)", () => {
    for (const [, error] of table) {
      const status = apiErrorStatus(mapDbError(error));
      expect([400, 401, 403, 404, 422, 500]).toContain(status);
    }
  });

  it("jamais de fuite : le message SQL brut n'est pas le code retourné", () => {
    for (const [, error] of table) {
      const out = mapDbError(error);
      if (error?.message && !["idempotency_conflict", "validation_failed", "unauthenticated"].includes(error.message.trim())) {
        expect(out).not.toBe(error.message);
      }
    }
  });

  it("correspondance statut HTTP par code", () => {
    expect(apiErrorStatus(mapDbError({ code: "P0001", message: "idempotency_conflict" }))).toBe(422);
    expect(apiErrorStatus(mapDbError({ code: "22023", message: "validation_failed" }))).toBe(400);
    expect(apiErrorStatus(mapDbError({ code: "28000", message: "unauthenticated" }))).toBe(401);
    expect(apiErrorStatus(mapDbError({ code: "42501" }))).toBe(403);
    expect(apiErrorStatus(mapDbError({ code: "99999", message: "x" }))).toBe(500);
  });
});
