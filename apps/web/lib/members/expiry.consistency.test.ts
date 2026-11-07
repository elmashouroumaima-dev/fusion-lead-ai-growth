import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INVITATION_EXPIRY_DAYS } from "@fusion-leap/domain";
import { describe, expect, it } from "vitest";

const MIGRATION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../supabase/migrations/20261110100000_invitations.sql",
);

describe("durée de validité d'une invitation : SQL et domaine alignés", () => {
  it("c_validity de la migration vaut INVITATION_EXPIRY_DAYS jours", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const match = /c_validity\s+constant\s+interval\s*:=\s*interval\s+'(\d+)\s+days?'/i.exec(sql);
    expect(match, "c_validity introuvable dans la migration").not.toBeNull();
    expect(Number(match?.[1])).toBe(INVITATION_EXPIRY_DAYS);
  });
});
