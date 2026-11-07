import { z } from "zod";

/**
 * Paramètres SMTP de la plateforme (Paramétrage, administrateurs de la plateforme). Miroir de
 * `private.is_valid_smtp_settings` (SQL). Le mot de passe n'appartient PAS aux paramètres stockés : il est chiffré par
 * l'application (ADR 004) et n'est jamais renvoyé.
 */

export const SMTP_SECURITIES = ["tls", "starttls", "none"] as const;
export type SmtpSecurity = (typeof SMTP_SECURITIES)[number];

/** Boîte de test Mailtrap (Email Testing) : valeurs publiques du service, sans identifiant. */
export const MAILTRAP_PRESET = {
  host: "sandbox.smtp.mailtrap.io",
  port: 2525,
  security: "starttls" as SmtpSecurity,
  /** Mailtrap accepte n'importe quel expéditeur : valeurs proposées pour préremplir le formulaire. */
  from_email: "no-reply@fusion-leap.test",
  from_name: "Fusion Leap",
};

const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
/** Caractère de contrôle (C0, DEL, C1). */
const hasControl = (value: string): boolean => [...value].some((c) => {
  const code = c.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
});
/** Marque bidirectionnelle, séparateur de ligne/paragraphe, largeur nulle, BOM ou caractère de balise (U+E0000-E007F). */
const hasBidiOrZeroWidth = (value: string): boolean => [...value].some((c) => {
  const code = c.codePointAt(0) ?? 0;
  return (
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff ||
    (code >= 0xe0000 && code <= 0xe007f)
  );
});
/** Adresse simple (RFC 5322 sans guillemets, commentaires ni nom affiché) : pas de virgule, de chevron ni d'espace. */
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/;

/** Chaîne de formulaire : rognée, vide = absente. */
const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : typeof v === "string" ? v.trim() : v), z.string().max(max).optional());

export const smtpHostSchema = z.string().trim().max(253).regex(HOST);

export const smtpSettingsSchema = z
  .object({
    host: smtpHostSchema,
    port: z.coerce.number().int().min(1).max(65535),
    security: z.enum(SMTP_SECURITIES),
    username: optionalText(255).refine((v) => v === undefined || (!hasControl(v) && !hasBidiOrZeroWidth(v)), "control"),
    /** Écriture seule : absent = on conserve le mot de passe enregistré. */
    password: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).max(512).optional()),
    from_email: z.string().trim().max(254).regex(EMAIL),
    from_name: optionalText(100).refine((v) => v === undefined || (!hasControl(v) && !hasBidiOrZeroWidth(v)), "control"),
  })
  .strict();
export type SmtpSettingsInput = z.infer<typeof smtpSettingsSchema>;

/** Formulaire sans champ (suppression, test d'envoi) : tout champ en trop est refusé. */
export const emptyActionSchema = z.object({}).strict();

/** Paramètres tels que renvoyés à l'administrateur (jamais le mot de passe : seulement `has_password`). */
export const smtpSettingsViewSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  security: z.enum(SMTP_SECURITIES),
  username: z.string().optional(),
  from_email: z.string(),
  from_name: z.string().optional(),
  has_password: z.boolean(),
});
export type SmtpSettingsView = z.infer<typeof smtpSettingsViewSchema>;

/** Configuration d'envoi lue côté serveur (secret chiffré seulement). */
export const smtpDeliverySchema = smtpSettingsViewSchema.omit({ has_password: true }).extend({
  secret: z
    .object({ id: z.uuid(), ciphertext: z.string(), nonce: z.string(), key_version: z.number().int().min(1) })
    .nullable(),
});
export type SmtpDelivery = z.infer<typeof smtpDeliverySchema>;

/** Hôte « interne » : adresse locale, privée, de lien local, forme numérique ambiguë ou nom de réseau interne. */
export function isInternalSmtpHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa")) {
    return true;
  }
  const labels = h.split(".");
  // Que des étiquettes numériques (décimal, octal, hexadécimal) : c'est une adresse IPv4, éventuellement en notation
  // abrégée ou exotique (2130706433, 0x7f.1, 017700000001) que les bibliothèques réseau interprètent : refusée sauf
  // forme décimale pointée standard et publique.
  if (labels.every((l) => /^(0x[0-9a-f]+|[0-9]+)$/.test(l))) {
    const standard = labels.length === 4 && labels.every((l) => /^(0|[1-9][0-9]{0,2})$/.test(l) && Number(l) <= 255);
    if (!standard) return true;
    return isPrivateIPv4(labels.map(Number) as [number, number, number, number]);
  }
  return false;
}

/** Adresse IPv4 non routable publiquement (boucle, privée, lien local, CGNAT, non spécifiée, multicast, réservée). */
export function isPrivateIPv4([a, b]: readonly [number, number, number, number]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** IPv6 en huit groupes de 16 bits (gère `::` et une fin IPv4) ; `null` si la forme est invalide. */
function parseIPv6(input: string): number[] | null {
  let s = input.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(":")) return null;
  const v4 = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1, 5).map(Number) as [number, number, number, number];
    if ([a, b, c, d].some((n) => n > 255)) return null;
    s = s.slice(0, s.length - v4[0].length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? "");
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = parse(halves[1] ?? "");
  if (tail === null || head.length + tail.length > 7) return null;
  return [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

/**
 * Adresse IP (v4 ou v6) non routable publiquement : contrôle le résultat de la résolution DNS. Par défaut REFUSÉE :
 * pour l'IPv6, seules les adresses unicast globales (2000::/3) hors 6to4 (2002::/16), Teredo (2001::/32) et
 * documentation (2001:db8::/32) sont acceptées ; une adresse IPv4-mappée est jugée d'après son IPv4 ; toute forme
 * invalide est refusée.
 */
export function isPrivateIp(ip: string): boolean {
  const dotted = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const octets = dotted.slice(1, 5).map(Number) as [number, number, number, number];
    return octets.some((n) => n > 255) || isPrivateIPv4(octets);
  }
  const g = parseIPv6(ip);
  if (!g) return true;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return isPrivateIPv4([(g[6]! >> 8) & 255, g[6]! & 255, (g[7]! >> 8) & 255, g[7]! & 255]);
  }
  if ((g[0]! & 0xe000) !== 0x2000) return true;
  if (g[0] === 0x2002) return true;
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0x0db8)) return true;
  return false;
}
