import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Icônes de l'onglet (convention de fichiers de Next : `app/icon.png`, `app/apple-icon.png`, `app/favicon.ico`). Sans elles le navigateur affiche
 * un globe générique. Le test ne vérifie que la forme des fichiers (PNG valide et carré, tailles attendues, en-tête ICO) : l'aspect est celui
 * du « F » du logo officiel sur le vert de marque (`--brand`).
 */
const appDir = path.join(__dirname, "app");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(path.join(appDir, file));
  expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE), `${file} : signature PNG`).toBe(true);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("icônes de l'application", () => {
  it("icon.png est un PNG carré d'au moins 192 px (onglet et raccourcis)", () => {
    const { width, height } = pngSize("icon.png");
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(192);
  });

  it("apple-icon.png fait 180 × 180 px (écran d'accueil iOS)", () => {
    expect(pngSize("apple-icon.png")).toEqual({ width: 180, height: 180 });
  });

  it("favicon.ico est un fichier ICO avec au moins une image (anciens navigateurs)", () => {
    const bytes = readFileSync(path.join(appDir, "favicon.ico"));
    expect(bytes.readUInt16LE(0)).toBe(0); // réservé
    expect(bytes.readUInt16LE(2)).toBe(1); // type : icône
    expect(bytes.readUInt16LE(4)).toBeGreaterThanOrEqual(1); // nombre d'images
  });
});
