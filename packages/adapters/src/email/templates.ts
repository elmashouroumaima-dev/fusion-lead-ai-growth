import { EMAIL_LANGS, renderEmailHtml, renderEmailText, type EmailContent, type EmailLang } from "./layout";

/**
 * E-mails de la plateforme, UNE langue par message.
 *  - Messages d'authentification : les fichiers `supabase/templates/*.html` sont GÉNÉRÉS d'ici (`pnpm email:templates`) ;
 *    chacun contient les trois variantes, choisies par Supabase Auth selon `user_metadata.locale` (langue de
 *    l'inscription ou de la dernière connexion, français par défaut). Un test échoue si un fichier diffère de la source.
 *    Cette préférence n'a aucun rôle d'autorisation : elle ne sert qu'à choisir le texte.
 *  - Message de test SMTP : langue de l'interface de l'administrateur qui le déclenche.
 * Les variables `{{ .SiteURL }}` et `{{ .TokenHash }}` sont celles de Supabase Auth, insérées telles quelles.
 */

export const AUTH_LOGO_URL = "{{ .SiteURL }}/brand/email-logo.png";

const CONFIRMATION: EmailContent = {
  fr: {
    title: "Confirmez votre adresse e-mail",
    body: "Merci de votre inscription à Fusion Leap AI Growth. Cliquez sur le bouton ci-dessous pour confirmer votre compte.",
    button: "Confirmer mon e-mail",
    note: "Si vous n’avez pas créé de compte, ignorez ce message.",
  },
  ar: {
    title: "أكِّد عنوان بريدك الإلكتروني",
    body: "شكرًا لتسجيلك في Fusion Leap AI Growth. اضغط على الزر أدناه لتأكيد حسابك.",
    button: "تأكيد بريدي الإلكتروني",
    note: "إذا لم تنشئ حسابًا، فتجاهل هذه الرسالة.",
  },
  en: {
    title: "Confirm your email address",
    body: "Thanks for signing up for Fusion Leap AI Growth. Click the button below to confirm your account.",
    button: "Confirm my email",
    note: "If you did not create an account, ignore this email.",
  },
};

const RECOVERY: EmailContent = {
  fr: {
    title: "Réinitialisez votre mot de passe",
    body: "Vous avez demandé à réinitialiser votre mot de passe. Cliquez sur le bouton ci-dessous pour en choisir un nouveau.",
    button: "Choisir un nouveau mot de passe",
    note: "Si vous n’avez pas fait cette demande, ignorez ce message.",
  },
  ar: {
    title: "إعادة تعيين كلمة المرور",
    body: "لقد طلبتَ إعادة تعيين كلمة مرورك. اضغط على الزر أدناه لاختيار كلمة مرور جديدة.",
    button: "اختيار كلمة مرور جديدة",
    note: "إذا لم تطلب ذلك، فتجاهل هذه الرسالة.",
  },
  en: {
    title: "Reset your password",
    body: "You asked to reset your password. Click the button below to choose a new one.",
    button: "Choose a new password",
    note: "If you did not request this, ignore this email.",
  },
};

const SMTP_TEST: EmailContent = {
  fr: {
    title: "Test de la configuration SMTP",
    body: "Ce message confirme que la configuration SMTP de la plateforme fonctionne.",
    note: "Message automatique : aucune action n’est requise.",
  },
  ar: {
    title: "اختبار إعدادات SMTP",
    body: "تؤكد هذه الرسالة أن إعدادات SMTP الخاصة بالمنصة تعمل.",
    note: "رسالة تلقائية: لا يلزم أي إجراء.",
  },
  en: {
    title: "SMTP configuration test",
    body: "This message confirms that the platform SMTP configuration works.",
    note: "Automatic message: no action is required.",
  },
};

export const CONFIRMATION_ACTION_HREF = "{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&amp;type=signup&amp;next=/dashboard";
export const RECOVERY_ACTION_HREF = "{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&amp;type=recovery&amp;next=/reset-password";

/** Langue demandée par Supabase Auth : `$l` vaut `user_metadata.locale` s'il existe, sinon vide (français par défaut). */
const GO_LOCALE_PREFIX = '{{- $l := "" }}{{ with .Data.locale }}{{ $l = . }}{{ end -}}';

/** Assemble les trois variantes en un conditionnel Go ; `pick` donne le texte de chaque langue. */
function goByLocale(pick: (lang: EmailLang) => string): string {
  return `${GO_LOCALE_PREFIX}{{ if eq $l "ar" }}${pick("ar")}{{ else if eq $l "en" }}${pick("en")}{{ else }}${pick("fr")}{{ end }}`;
}

const DOCUMENT_TITLE = { fr: "Fusion Leap AI Growth", ar: "Fusion Leap AI Growth", en: "Fusion Leap AI Growth" } as const;

function authTemplate(content: EmailContent, actionHref: string): string {
  return goByLocale((lang) =>
    renderEmailHtml({ lang, documentTitle: `${content[lang].title} · ${DOCUMENT_TITLE[lang]}`, copy: content[lang], actionHref, logoSrc: AUTH_LOGO_URL }),
  );
}

export const renderConfirmationTemplate = (): string => authTemplate(CONFIRMATION, CONFIRMATION_ACTION_HREF);
export const renderRecoveryTemplate = (): string => authTemplate(RECOVERY, RECOVERY_ACTION_HREF);

/** Objets des messages d'authentification (`supabase/config.toml`), choisis par la même langue. */
export const renderConfirmationSubject = (): string => goByLocale((lang) => CONFIRMATION[lang].title);
export const renderRecoverySubject = (): string => goByLocale((lang) => RECOVERY[lang].title);

/** Message de test SMTP : logo joint (`cid:`) pour s'afficher dans tout client, même hors ligne ou en local. */
export const SMTP_TEST_LOGO_CID = "fusion-leap-logo";

/** Date et heure du message (UTC : « samedi 7 novembre 2026 | 14:34:50 UTC »), dans la langue du message. */
function dateLabel(now: Date, lang: EmailLang): string {
  const locale = lang === "ar" ? "ar-MA-u-nu-latn" : lang === "en" ? "en-GB" : "fr-FR";
  const day = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(now);
  const time = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" }).format(now);
  return `${day} | ${time} UTC`;
}

export function isEmailLang(value: unknown): value is EmailLang {
  return typeof value === "string" && (EMAIL_LANGS as readonly string[]).includes(value);
}

export function renderSmtpTestEmail(now: Date, lang: EmailLang): { subject: string; html: string; text: string } {
  const year = now.getUTCFullYear();
  const copy = SMTP_TEST[lang];
  return {
    subject: `Fusion Leap AI Growth : ${copy.title}`,
    html: renderEmailHtml({ lang, documentTitle: copy.title, copy, logoSrc: `cid:${SMTP_TEST_LOGO_CID}`, year, dateLabel: dateLabel(now, lang) }),
    text: renderEmailText({ lang, copy, year }),
  };
}
