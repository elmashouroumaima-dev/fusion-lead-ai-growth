import { describe, expect, it } from "vitest";
import {
  ASSET_MAX_BYTES,
  assetFileName,
  buildAssetPath,
  checkAssetBytes,
  detectAssetType,
  isAssetPathOf,
  isImageAsset,
  sanitizeAssetFileName,
} from "./assets";
import { assetPathSchema } from "./schemas";

const bytes = (...values: number[]) => Uint8Array.from(values);
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10);
const WEBP = bytes(...ascii("RIFF"), 1, 0, 0, 0, ...ascii("WEBP"), ...ascii("VP8 "));
const PDF = bytes(...ascii("%PDF-1.7\n"));

const ORG = "7f000000-0000-4000-8000-00000000000a";
const PROJECT = "7c100000-0000-4000-8000-0000000000a1";
const ASSET = "7d100000-0000-4000-8000-000000000001";

describe("type réel par les octets", () => {
  it("png, jpeg, webp, pdf reconnus", () => {
    expect(detectAssetType(PNG)).toBe("png");
    expect(detectAssetType(JPEG)).toBe("jpeg");
    expect(detectAssetType(WEBP)).toBe("webp");
    expect(detectAssetType(PDF)).toBe("pdf");
  });

  it("SVG, HTML, script, exécutable, archive, GIF, texte : refusés", () => {
    const samples = [
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      new TextEncoder().encode("<!doctype html><script>alert(1)</script>"),
      new TextEncoder().encode("<?xml version='1.0'?><svg/>"),
      bytes(0x4d, 0x5a, 0x90, 0), // MZ (exécutable Windows)
      bytes(0x7f, 0x45, 0x4c, 0x46), // ELF
      bytes(0x50, 0x4b, 0x03, 0x04), // ZIP
      new TextEncoder().encode("GIF89a"),
      new TextEncoder().encode("nom,email\nA,a@exemple.test"),
    ];
    for (const sample of samples) expect(detectAssetType(sample)).toBeNull();
  });

  it("signatures tronquées ou incomplètes refusées (RIFF sans WEBP, PNG coupé)", () => {
    expect(detectAssetType(bytes(...ascii("RIFF"), 1, 0, 0, 0, ...ascii("WAVE")))).toBeNull();
    expect(detectAssetType(bytes(0x89, 0x50, 0x4e))).toBeNull();
    expect(detectAssetType(bytes())).toBeNull();
    expect(detectAssetType(bytes(...ascii("%PDF")))).toBeNull();
  });

  it("le type est celui des OCTETS, pas du nom : un PDF nommé .png reste un PDF", () => {
    const check = checkAssetBytes(PDF);
    expect(check).toMatchObject({ ok: true, type: "pdf", mime: "application/pdf", extension: "pdf" });
  });
});

describe("limites", () => {
  it("vide et trop gros refusés, 5 Mo exactement accepté", () => {
    expect(checkAssetBytes(bytes())).toEqual({ ok: false, code: "empty" });
    const exactly = new Uint8Array(ASSET_MAX_BYTES);
    exactly.set(PNG);
    expect(checkAssetBytes(exactly).ok).toBe(true);
    const tooBig = new Uint8Array(ASSET_MAX_BYTES + 1);
    tooBig.set(PNG);
    expect(checkAssetBytes(tooBig)).toEqual({ ok: false, code: "too_large" });
  });

  it("type non supporté signalé", () => {
    expect(checkAssetBytes(new TextEncoder().encode("hello"))).toEqual({ ok: false, code: "unsupported_type" });
  });
});

describe("nom d'objet", () => {
  it.each([
    ["Logo Final.PNG", "png", "logo-final.png"],
    ["../../etc/passwd", "png", "etc-passwd.png"],
    ["a b\tc\n.jpg", "jpg", "a-b-c.jpg"],
    ["شعار.png", "png", "fichier.png"],
    ["", "pdf", "fichier.pdf"],
    ["...", "pdf", "fichier.pdf"],
    ["photo_été (2).webp", "webp", "photo_ete-2.webp"],
    ["<script>.png", "png", "script.png"],
  ])("%j -> %s", (original, ext, expected) => {
    expect(sanitizeAssetFileName(original, ext)).toBe(expected);
  });

  it("80 caractères au plus avant l'extension ; résultat toujours accepté par le schéma de chemin", () => {
    const name = sanitizeAssetFileName("x".repeat(500) + ".png", "png");
    expect(name.length).toBeLessThanOrEqual(84);
    for (const original of ["a.png", "Å é ü.png", "..", "%2e%2e%2f", "x".repeat(300)]) {
      const path = buildAssetPath(ORG, PROJECT, ASSET, sanitizeAssetFileName(original, "png"));
      expect(assetPathSchema.safeParse(path).success, original).toBe(true);
      expect(isAssetPathOf(path, ORG, PROJECT), original).toBe(true);
    }
  });
});

describe("chemins", () => {
  const good = buildAssetPath(ORG, PROJECT, ASSET, "logo.png");

  it("appartenance à l'entreprise ET au projet", () => {
    expect(isAssetPathOf(good, ORG, PROJECT)).toBe(true);
    expect(isAssetPathOf(good, "7f000000-0000-4000-8000-00000000000b", PROJECT)).toBe(false);
    expect(isAssetPathOf(good, ORG, "7c100000-0000-4000-8000-0000000000a2")).toBe(false);
  });

  it("formes invalides refusées", () => {
    for (const bad of [`${ORG}/${PROJECT}/logo.png`, `${ORG}/${PROJECT}/${ASSET}/../x.png`, `${ORG}/${PROJECT}/${ASSET}/a b.png`, `${ORG}/${PROJECT}/${ASSET}/sous/x.png`, "logo.png", ""]) {
      expect(isAssetPathOf(bad, ORG, PROJECT), bad).toBe(false);
    }
    expect(isAssetPathOf(good.toUpperCase(), ORG, PROJECT)).toBe(false);
  });

  it("nom affiché et aperçu", () => {
    expect(assetFileName(good)).toBe("logo.png");
    expect(isImageAsset("a/b/c/photo.JPG")).toBe(true);
    expect(isImageAsset("a/b/c/doc.pdf")).toBe(false);
  });
});
