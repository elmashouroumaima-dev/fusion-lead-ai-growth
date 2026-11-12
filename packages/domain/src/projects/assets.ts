/**
 * Fichiers des produits (J17, partie 2 ; ADR 005 §12, ADR 007 G-D11). Fonctions pures : détection du type RÉEL par les octets
 * (jamais par le nom ni par le type annoncé par le navigateur), limites de taille, nom d'objet généré par le serveur, chemin
 * `{organisation}/{projet}/{fichier}/{nom}` (miroir de `private.asset_path_ok` côté base).
 */

export const ASSET_TYPES = ["png", "jpeg", "webp", "pdf"] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export const ASSET_MIME: Record<AssetType, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  pdf: "application/pdf",
};
export const ASSET_EXTENSION: Record<AssetType, string> = { png: "png", jpeg: "jpg", webp: "webp", pdf: "pdf" };

/**
 * Limite d'un fichier : 5 Mo pour tous les types au J17 (la spec autorise 10 Mo pour un PDF : à relever avec un envoi par route
 * dédiée ; la limite des corps de Server Actions est de 6 Mo). Le bucket impose 10 Mo au plus.
 */
export const ASSET_MAX_BYTES = 5 * 1024 * 1024;
/** Un produit porte 50 fichiers au plus (contrainte de la base sur `products.assets`). */
export const ASSET_MAX_PER_PRODUCT = 50;
/** Durée des liens signés de lecture : courte, générés par le serveur à chaque affichage. */
export const ASSET_SIGNED_URL_SECONDS = 60;

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((value, index) => bytes[offset + index] === value);

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/** Type réel d'après les octets de tête, ou `null` (SVG, HTML, exécutable, archive… : refusés). */
export function detectAssetType(bytes: Uint8Array): AssetType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "webp";
  if (startsWith(bytes, ascii("%PDF-"))) return "pdf";
  return null;
}

export type AssetCheck =
  | { ok: true; type: AssetType; mime: string; extension: string }
  | { ok: false; code: "empty" | "too_large" | "unsupported_type" };

/** Contrôle d'un fichier avant envoi : non vide, taille, type réel. */
export function checkAssetBytes(bytes: Uint8Array): AssetCheck {
  if (bytes.length === 0) return { ok: false, code: "empty" };
  if (bytes.length > ASSET_MAX_BYTES) return { ok: false, code: "too_large" };
  const type = detectAssetType(bytes);
  if (type === null) return { ok: false, code: "unsupported_type" };
  return { ok: true, type, mime: ASSET_MIME[type], extension: ASSET_EXTENSION[type] };
}

/**
 * Nom d'objet sûr : minuscules ASCII, chiffres, `.`, `_`, `-` ; 80 caractères au plus avant l'extension ; l'extension est celle du
 * type RÉEL du fichier (un `.png` qui contient un PDF devient `.pdf`). Nom vide ou entièrement non ASCII (arabe…) : « fichier ».
 */
export function sanitizeAssetFileName(originalName: string, extension: string): string {
  const base = originalName
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "") // accents : é -> e
    .replace(/\.[A-Za-z0-9]{1,8}$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 80)
    .replace(/[-._]+$/g, "");
  return `${base || "fichier"}.${extension}`;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ASSET_PATH_SHAPE = new RegExp(`^(${UUID})/(${UUID})/(${UUID})/([A-Za-z0-9._-]{1,120})$`);

/** Chemin d'objet : `{organisation}/{projet}/{fichier}/{nom}` (UUID en minuscules). */
export function buildAssetPath(organizationId: string, projectId: string, assetId: string, fileName: string): string {
  return `${organizationId}/${projectId}/${assetId}/${fileName}`;
}

/** Le chemin appartient-il à CETTE entreprise et à CE projet (et a-t-il la forme attendue) ? */
export function isAssetPathOf(path: string, organizationId: string, projectId: string): boolean {
  const match = ASSET_PATH_SHAPE.exec(path);
  return match !== null && match[1] === organizationId && match[2] === projectId && !path.includes("..");
}

/** Nom affiché : dernier segment du chemin. */
export function assetFileName(path: string): string {
  const match = ASSET_PATH_SHAPE.exec(path);
  return match?.[4] ?? path.split("/").pop() ?? path;
}

/** Les images s'affichent en aperçu ; les PDF se téléchargent. */
export const isImageAsset = (path: string): boolean => /\.(png|jpe?g|webp)$/i.test(path);
