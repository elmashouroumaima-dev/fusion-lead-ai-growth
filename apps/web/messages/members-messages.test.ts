import { readFileSync } from "node:fs";
import path from "node:path";
import { APP_ROLES } from "@fusion-leap/domain";
import { describe, expect, it } from "vitest";
import ar from "./ar.json";
import en from "./en.json";

const WEB_ROOT = path.resolve(__dirname, "..");
type Json = string | { [k: string]: Json };

function leafPaths(obj: Json, prefix = ""): string[] {
  if (typeof obj === "string") return [prefix];
  return Object.entries(obj).flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k));
}

describe("Members.* et Invite.* : parité ar / en", () => {
  it.each(["Members", "Invite"] as const)("%s : mêmes clés, valeurs non vides, arabe réellement arabe", (ns) => {
    expect(leafPaths(ar[ns] as Json).sort()).toEqual(leafPaths(en[ns] as Json).sort());
    for (const p of leafPaths(ar[ns] as Json)) {
      const get = (root: Json) => p.split(".").reduce<unknown>((a, k) => (a as Record<string, unknown>)[k], root) as string;
      expect(get(en[ns] as Json).trim(), `en ${p}`).not.toBe("");
      expect(get(ar[ns] as Json), `ar ${p}`).toMatch(/[؀-ۿ]/);
    }
  });

  it("un message pour chaque code d'erreur de lib/members/types.ts (+ loadFailed), sans clé en trop", () => {
    const src = readFileSync(path.join(WEB_ROOT, "lib/members/types.ts"), "utf8");
    const declared = [...src.matchAll(/\|\s*"([a-z_]+)"/g)].map((m) => m[1] as string).filter((c) => !["idle", "error", "success"].includes(c));
    for (const members of [ar.Members, en.Members]) {
      expect(Object.keys(members.errors).sort()).toEqual([...declared, "loadFailed"].sort());
    }
  });

  it("les messages de succès couvrent les clés utilisées par ActionFeedback", () => {
    for (const members of [ar.Members, en.Members]) {
      expect(Object.keys(members.success).sort()).toEqual(["removed", "revoked", "roleChanged", "transferred"]);
    }
  });

  it("le message d'invitation invalide est unique et ne contient aucun détail (pas de cause distincte)", () => {
    for (const invite of [ar.Invite, en.Invite]) expect(Object.keys(invite.errors)).toEqual(["invitation_invalid"]);
  });

  it("les libellés de rôle utilisés par l'interface existent pour chaque rôle (Org.roles)", () => {
    for (const org of [ar.Org, en.Org]) expect(Object.keys(org.roles).sort()).toEqual([...APP_ROLES].sort());
  });
});
