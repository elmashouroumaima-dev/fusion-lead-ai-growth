import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = path.resolve(__dirname, "..", "..");
const DIRS = ["components/ui", "components/layout", "components/brand", "components/theme", "components/org"];

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(WEB_ROOT, dir))
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
    .map((f) => path.join(dir, f));
}

/**
 * Classes Tailwind PHYSIQUES interdites (ADR 011/015) : le préfixe doit commencer un mot de classe
 * (début, espace, guillemet, « : » d'une variante, « [ » ou « ! »). Les formes `slide-in-from-left`
 * (animations liées au côté Radix) et les variantes `rtl:`/`ltr:` explicites restent permises.
 */
const PHYSICAL =
  /(?:^|[\s"'`:!])-?(?:(?:ml|mr|pl|pr|left|right|scroll-ml|scroll-mr|scroll-pl|scroll-pr|rounded-[lr]|rounded-t[lr]|rounded-b[lr]|border-[lr])-|(?:float-left|float-right|text-left|text-right|rounded-l|rounded-r|border-l|border-r)(?=[\s"'`]|$))/;

describe("composants UI : classes logiques uniquement (RTL)", () => {
  for (const dir of DIRS) {
    for (const file of sourceFiles(dir)) {
      it(file, () => {
        const lines = readFileSync(path.join(WEB_ROOT, file), "utf8").split("\n");
        const offenders = lines
          .map((line, i) => ({ line, n: i + 1 }))
          .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .filter(({ line }) => PHYSICAL.test(line))
          .map(({ n, line }) => `${n}: ${line.trim().slice(0, 100)}`);
        expect(offenders).toEqual([]);
      });
    }
  }

  it("la détection repère bien les classes physiques", () => {
    for (const bad of ['className="ml-2"', "sm:pr-4", "text-left", "rounded-l-md", "border-r", "left-0", "-mr-1"]) {
      expect(PHYSICAL.test(bad), bad).toBe(true);
    }
    for (const ok of ["ms-2", "pe-4", "text-start", "rounded-s-md", "border-e", "start-0", "slide-in-from-left-2", "rtl:rotate-180"]) {
      expect(PHYSICAL.test(ok), ok).toBe(false);
    }
  });
});
