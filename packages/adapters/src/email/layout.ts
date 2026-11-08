/**
 * Gabarit des e-mails de la plateforme (confirmation, réinitialisation, test SMTP) : tableaux HTML et styles en ligne
 * (Gmail, Outlook, Apple Mail, Mailtrap), 600 px maximum. UNE seule langue par message (fr, ar en RTL ou en) : celle de
 * la session ou du profil du destinataire. En tête : logo et nom ; en pied : barre « Tous droits réservés ».
 * Un seul gabarit produit les fichiers de `supabase/templates` (variables Go `{{ .SiteURL }}` laissées telles quelles,
 * une variante par langue) ET le message de test envoyé par l'application.
 */

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
  /** Source du logo : URL publique ou `cid:...`. */
  logoSrc: string;
  /** Année affichée dans le pied (absente : pied sans année, pour les gabarits statiques). */
  year?: number;
  /** Date et heure affichées à droite de la signature (absente : rien, pour les gabarits statiques). */
  dateLabel?: string;
};

const BRAND_NAME = "Fusion Leap AI Growth";
const GREEN = "#006a4e";
const DARK_GREEN = "#00382a";
const RED = "#ae2b2f";
/** Logo officiel (blanc, transparent) : `apps/web/public/brand/email-logo.png`, 480×97 px affiché à 260×53 px (2x pour les écrans denses). */
const LOGO_WIDTH = 260;
const LOGO_HEIGHT = 53;
const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const FONT_AR = "'Segoe UI',Tahoma,Arial,sans-serif";

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
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 4px;"><tr><td bgcolor="${GREEN}" style="border-radius:8px;"><a href="${actionHref}" target="_blank" style="display:inline-block;padding:13px 26px;font-family:${font};font-size:16px;font-weight:700;line-height:1.2;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(copy.button)}</a></td></tr></table>`
      : "";
  const note = copy.note
    ? `<p style="margin:16px 0 0;font-family:${font};font-size:13px;line-height:1.5;color:#52525b;">${escapeHtml(copy.note)}</p>`
    : "";
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
<body style="margin:0;padding:0;background-color:#f4f4f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f4f5" style="background-color:#f4f4f5;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #d4d4d8;">
<tr><td align="center" bgcolor="${GREEN}" height="170" style="background-color:${GREEN};background-image:linear-gradient(135deg,${DARK_GREEN},${GREEN} 62%,${RED});padding:58px 24px;">
<img src="${options.logoSrc}" width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}" alt="${BRAND_NAME}" style="display:block;margin:0 auto;width:${LOGO_WIDTH}px;height:${LOGO_HEIGHT}px;border:0;">
</td></tr>
<tr><td${dir} style="padding:32px 32px 28px;text-align:${align};font-family:${font};color:#18181b;"><h1 style="margin:0 0 14px;font-family:${font};font-size:22px;line-height:1.3;font-weight:700;color:${DARK_GREEN};">${escapeHtml(copy.title)}</h1><p style="margin:0;font-family:${font};font-size:16px;line-height:1.6;color:#3f3f46;">${escapeHtml(copy.body)}</p>${button}${note}</td></tr>
<tr><td style="padding:18px 32px;border-top:1px solid #e4e4e7;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="left" style="font-family:${FONT};font-size:14px;font-weight:700;color:#18181b;">${BRAND_NAME}</td>${dateCell}</tr></table></td></tr>
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
