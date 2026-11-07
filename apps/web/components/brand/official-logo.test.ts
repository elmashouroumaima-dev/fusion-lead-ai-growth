import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(path.join(WEB_ROOT, rel), "utf8");

describe("logo officiel des pages publiques", () => {
  it("est un fichier statique fixe : il ne dépend pas du logo personnalisé du Paramétrage", () => {
    const src = read("components/brand/official-logo.tsx");
    expect(src).toContain('src="/brand/logo-white.png"');
    expect(src).not.toMatch(/useContext|BrandLogoContext|BrandLogoProvider|\/api\/brand\/logo/);
    expect(statSync(path.join(WEB_ROOT, "public/brand/logo-white.png")).size).toBeGreaterThan(1000);
  });

  it("connexion, inscription, invitation (panneau de marque) et accueil l'utilisent, plus la marque graphique variable", () => {
    for (const file of ["components/public/brand-panel.tsx", "app/[locale]/page.tsx"]) {
      const src = read(file);
      expect(src, file).toContain("<OfficialLogo");
      expect(src, file).not.toContain("<LogoMark");
    }
  });

  it("a un texte alternatif (nom de l'application) et pas de logo décoratif sans nom", () => {
    expect(read("components/public/brand-panel.tsx")).toMatch(/<OfficialLogo alt=\{tc\("appName"\)\}/);
    expect(read("app/[locale]/page.tsx")).toMatch(/<OfficialLogo alt=\{tc\("appName"\)\}/);
  });
});
