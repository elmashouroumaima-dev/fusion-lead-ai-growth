import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import fr from "../../messages/fr.json";

const WEB_ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(path.join(WEB_ROOT, rel), "utf8");

describe("pied de page", () => {
  it("le texte existe en fr / ar / en et reprend l'année et le nom de l'application", () => {
    for (const [name, messages] of [["fr", fr], ["ar", ar], ["en", en]] as const) {
      const text = messages.Footer.copyright;
      expect(text, name).toContain("{year}");
      expect(text, name).toContain("{appName}");
    }
  });

  it("toutes les pages ont un pied de page : coquille de l'application (normale et réduite) et cadre public", () => {
    const shell = read("components/layout/app-shell.tsx");
    expect(shell.match(/<AppFooter\b/g)?.length).toBe(2);
    expect(read("components/public/public-frame.tsx")).toContain('<AppFooter tone="brand" />');
  });

  it("le pied de page est une balise <footer> sans lien (aucune page légale n'existe encore)", () => {
    const src = read("components/layout/app-footer.tsx");
    expect(src).toContain("<footer");
    expect(src).not.toMatch(/<a\b|<Link\b|href=/);
  });
});
