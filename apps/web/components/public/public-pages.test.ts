import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import fr from "../../messages/fr.json";

const WEB_ROOT = path.resolve(__dirname, "..", "..");

const PHYSICAL =
  /(?:^|[\s"'`:!])-?(?:(?:ml|mr|pl|pr|left|right|scroll-ml|scroll-mr|scroll-pl|scroll-pr|rounded-[lr]|rounded-t[lr]|rounded-b[lr]|border-[lr])-|(?:float-left|float-right|text-left|text-right|rounded-l|rounded-r|border-l|border-r)(?=[\s"'`]|$))/;

function tsxIn(dir: string): string[] {
  return readdirSync(path.join(WEB_ROOT, dir))
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
    .map((f) => path.join(dir, f));
}

describe("pages publiques et organisation : classes logiques (RTL)", () => {
  for (const file of [...tsxIn("components/public"), ...tsxIn("components/auth"), ...tsxIn("components/org")]) {
    it(file, () => {
      const offenders = readFileSync(path.join(WEB_ROOT, file), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .filter((line) => PHYSICAL.test(line));
      expect(offenders).toEqual([]);
    });
  }
});

describe("messages des pages publiques", () => {
  const catalogs = { fr, en, ar };
  for (const [locale, messages] of Object.entries(catalogs)) {
    it(`${locale} : puces de marque, bascule du mot de passe et libellé de liste`, () => {
      expect(Object.keys(messages.Auth.brand.features).sort()).toEqual(["fast", "governed", "secure"]);
      expect(messages.Auth.brand.featuresLabel.length).toBeGreaterThan(0);
      expect(messages.Auth.fields.showPassword.length).toBeGreaterThan(0);
      expect(messages.Auth.fields.hidePassword.length).toBeGreaterThan(0);
      expect(messages.Org.select.listLabel.length).toBeGreaterThan(0);
    });
  }
});
