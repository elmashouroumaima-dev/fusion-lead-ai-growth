import { z } from "zod";

/** Formats acceptés. SVG volontairement exclu (peut porter du script). Miroir de private.is_valid_logo (SQL). */
export const LOGO_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export type LogoMime = (typeof LOGO_MIMES)[number];

/** Taille maximale de l'image décodée (octets). Miroir de la contrainte SQL. */
export const MAX_LOGO_BYTES = 131072;
/** Longueur maximale du base64 correspondant (4/3), plafonne la charge utile avant tout décodage. */
export const MAX_LOGO_BASE64_LENGTH = 174764;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Décode un base64 strict ; `null` si invalide (caractères, longueur, remplissage). */
export function decodeBase64(data: string): Uint8Array | null {
  if (data.length < 8 || data.length > MAX_LOGO_BASE64_LENGTH || data.length % 4 !== 0 || !BASE64.test(data)) return null;
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);

/** Type réel d'après les octets de signature (PNG, JPEG, WebP), indépendamment du type annoncé. */
export function detectImageMime(bytes: Uint8Array): LogoMime | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

export type Logo = { mime: LogoMime; data: string };

/** Logo valide : type autorisé, base64 strict, ≤ 128 Ko décodés, signature conforme au type annoncé. */
export const logoSchema = z
  .object({ mime: z.enum(LOGO_MIMES), data: z.string().max(MAX_LOGO_BASE64_LENGTH) })
  .strict()
  .refine(
    (logo) => {
      const bytes = decodeBase64(logo.data);
      return bytes !== null && bytes.length <= MAX_LOGO_BYTES && detectImageMime(bytes) === logo.mime;
    },
    { message: "invalid_logo" },
  );

/** Le formulaire envoie le logo en JSON (champ caché) : analysé et validé ici, jamais fait confiance. */
const logoJson = z
  .string()
  .max(MAX_LOGO_BASE64_LENGTH + 64)
  .transform((raw, ctx): Logo => {
    try {
      const parsed = logoSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      /* JSON invalide : traité comme entrée invalide ci-dessous */
    }
    ctx.addIssue({ code: "custom", message: "invalid_logo" });
    return z.NEVER;
  });

export const saveLogoSchema = z.object({ logo: logoJson }).strict();
export type SaveLogoInput = z.infer<typeof saveLogoSchema>;

export const resetLogoSchema = z.object({}).strict();
