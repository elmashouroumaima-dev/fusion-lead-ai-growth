/**
 * Gabarit des e-mails de la plateforme (confirmation, réinitialisation, test SMTP) : tableaux HTML et styles en ligne
 * (Gmail, Outlook, Apple Mail, Mailtrap), 600 px maximum. UNE seule langue par message (fr, ar en RTL ou en) : celle de
 * la session ou du profil du destinataire. En tête : logo et nom ; en pied : barre « Tous droits réservés ».
 * Un seul gabarit produit les fichiers de `supabase/templates` (variables Go `{{ .SiteURL }}` laissées telles quelles,
 * une variante par langue) ET le message de test envoyé par l'application.
 */

import { EMAIL_MARK_DATA_URI } from "./mark";

export type EmailLang = "fr" | "ar" | "en";
export const EMAIL_LANGS: readonly EmailLang[] = ["fr", "ar", "en"];

export type EmailCopy = {
  title: string;
  body: string;
  /** Libellé du bouton, absent s'il n'y a pas d'action. */
  button?: string;
  note?: string;
};

export type EmailContent = Record<EmailLang, EmailCopy>;

export type EmailLayoutOptions = {
  lang: EmailLang;
  /** Titre du document (aperçu dans certains clients). */
  documentTitle: string;
  copy: EmailCopy;
  /** URL du bouton (absente : pas de bouton). Peut contenir des variables Go : elle est insérée telle quelle. */
  actionHref?: string;
  /**
   * Source du logo : URL publique ou `cid:...`. Absente : logotype en HTML (marque « F » + « FUSION LEAP »), qui s'affiche dans
   * tout client, même quand les images sont bloquées ou que l'adresse du site est locale (messages d'authentification).
   */
  logoSrc?: string;
  /** Année affichée dans le pied (absente : pied sans année, pour les gabarits statiques). */
  year?: number;
  /** Date et heure affichées à droite de la signature (absente : rien, pour les gabarits statiques). */
  dateLabel?: string;
};

const BRAND_NAME = "Fusion Leap AI Growth";
// Palette Mintlify : noir et vert (alignée sur le thème de l'application, ADR 015).
const INK = "#0a0a0a";
const TEAL_DARK = "#1a3d4a";
const GREEN = "#00b48a";
const GREEN_TEXT = "#00775f";
/** Barre du pied de page (« Tous droits réservés ») : rouge de la marque, texte blanc (contraste AA). */
const RED = "#ae2b2f";
/** Logo officiel (blanc, transparent) : `apps/web/public/brand/email-logo.png`, 480×97 px affiché à 260×53 px (2x pour les écrans denses). */
const LOGO_WIDTH = 260;
const LOGO_HEIGHT = 53;
const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const FONT_AR = "'Segoe UI',Tahoma,Arial,sans-serif";

/** Phrase de secours quand le bouton ne s'affiche pas (clients qui bloquent les styles) : le lien est répété en clair. */
const FALLBACK: Record<EmailLang, string> = {
  fr: "Le bouton ne fonctionne pas ? Copiez ce lien dans votre navigateur :",
  ar: "إذا لم يعمل الزر، انسخ هذا الرابط إلى متصفحك:",
  en: "Button not working? Copy this link into your browser:",
};

const FOOTER: Record<EmailLang, string> = {
  fr: "Tous droits réservés.",
  ar: "جميع الحقوق محفوظة.",
  en: "All rights reserved.",
};

/** Échappe le texte inséré (les contenus sont statiques, mais le gabarit reste sûr s'ils changent). */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderEmailHtml(options: EmailLayoutOptions): string {
  const { lang, copy, actionHref } = options;
  const rtl = lang === "ar";
  const font = rtl ? FONT_AR : FONT;
  const dir = rtl ? ' dir="rtl"' : "";
  const align = rtl ? "right" : "left";
  const year = options.year === undefined ? "" : `${options.year} `;

  const button =
    copy.button && actionHref
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 4px;"><tr><td bgcolor="${INK}" style="border-radius:999px;"><a href="${actionHref}" target="_blank" style="display:inline-block;padding:14px 32px;font-family:${font};font-size:16px;font-weight:700;line-height:1.2;color:#ffffff;text-decoration:none;border-radius:999px;">${escapeHtml(copy.button)}</a></td></tr></table><p style="margin:18px 0 0;font-family:${font};font-size:12px;line-height:1.5;color:#71717a;">${FALLBACK[lang]}<br><a href="${actionHref}" target="_blank" style="color:${GREEN_TEXT};word-break:break-all;text-decoration:underline;">${actionHref}</a></p>`
      : "";
  const note = copy.note
    ? `<p style="margin:22px 0 0;padding-top:16px;border-top:1px solid #ededed;font-family:${font};font-size:13px;line-height:1.5;color:#52525b;">${escapeHtml(copy.note)}</p>`
    : "";
  const logo = options.logoSrc
    ? `<img src="${options.logoSrc}" width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}" alt="${BRAND_NAME}" style="display:block;margin:0 auto;width:${LOGO_WIDTH}px;height:${LOGO_HEIGHT}px;border:0;color:#ffffff;font-family:${FONT};font-size:22px;font-weight:700;line-height:53px;text-align:center;">`
    : `<table role="presentation" dir="ltr" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr><td width="48" valign="middle" style="width:48px;"><img src="${EMAIL_MARK_DATA_URI}" width="44" height="40" alt="" style="display:block;width:44px;height:40px;border:0;"></td><td style="padding-left:16px;text-align:left;"><span style="display:block;font-family:${FONT};font-size:28px;font-weight:700;line-height:30px;letter-spacing:4px;color:#ffffff;">FUSION LEAP</span><span style="display:block;margin-top:4px;font-family:${FONT};font-size:11px;font-weight:600;line-height:14px;letter-spacing:5px;color:#b3b3b3;">AI GROWTH</span></td></tr></table>`;
  const dateCell = options.dateLabel
    ? `<td align="right" style="font-family:${FONT};font-size:14px;font-weight:700;color:#18181b;">${escapeHtml(options.dateLabel)}</td>`
    : "";

  return `<!doctype html>
<html lang="${lang}"${dir}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(options.documentTitle)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f7f7f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f7f7f7" style="background-color:#f7f7f7;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #e5e5e5;border-radius:16px;overflow:hidden;">
<tr><td align="center" bgcolor="${INK}" height="150" style="background-color:${INK};background-image:linear-gradient(135deg,${INK},${TEAL_DARK} 55%,${GREEN});padding:48px 24px;">
${logo}
</td></tr>
<tr><td${dir} style="padding:36px 36px 32px;text-align:${align};font-family:${font};color:#18181b;"><h1 style="margin:0 0 14px;font-family:${font};font-size:24px;line-height:1.3;font-weight:700;color:${INK};">${escapeHtml(copy.title)}</h1><p style="margin:0;font-family:${font};font-size:16px;line-height:1.6;color:#3f3f46;">${escapeHtml(copy.body)}</p>${button}${note}</td></tr>
<tr><td bgcolor="#fafafa" style="background-color:#fafafa;padding:18px 36px;border-top:1px solid #ededed;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="left" style="font-family:${FONT};font-size:14px;font-weight:700;color:${INK};">${BRAND_NAME}</td>${dateCell}</tr></table></td></tr>
<tr><td bgcolor="${RED}" style="background-color:${RED};padding:14px 24px;">
<p${dir} style="margin:0;font-family:${font};font-size:12px;font-weight:700;line-height:1.5;color:#ffffff;text-align:center;">© ${year}${BRAND_NAME}. ${FOOTER[lang]}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
}

/** Version texte (clients sans HTML) : titre, texte, lien et pied de page, dans la langue du message. */
export function renderEmailText(options: Pick<EmailLayoutOptions, "lang" | "copy" | "actionHref" | "year">): string {
  const { copy } = options;
  const year = options.year === undefined ? "" : `${options.year} `;
  return [
    copy.title,
    "",
    copy.body,
    ...(copy.button && options.actionHref ? ["", `${copy.button} : ${options.actionHref}`] : []),
    ...(copy.note ? ["", copy.note] : []),
    "",
    `© ${year}${BRAND_NAME}. ${FOOTER[options.lang]}`,
    "",
  ].join("\n");
}
