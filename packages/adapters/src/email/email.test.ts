import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EMAIL_LANGS, escapeHtml, renderEmailHtml, renderEmailText } from "./layout";
import {
  AUTH_LOGO_URL,
  CONFIRMATION_ACTION_HREF,
  RECOVERY_ACTION_HREF,
  SMTP_TEST_LOGO_CID,
  isEmailLang,
  renderConfirmationSubject,
  renderConfirmationTemplate,
  renderRecoverySubject,
  renderRecoveryTemplate,
  renderSmtpTestEmail,
} from "./templates";

const ROOT = path.resolve(__dirname, "../../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const NOW = new Date("2026-11-07T14:34:50Z");

/** Variante d'une langue dans un gabarit d'authentification (le conditionnel Go choisit une branche). */
function variant(template: string, lang: "fr" | "ar" | "en"): string {
  const branches = template.split(/\{\{ else if eq \$l "en" \}\}|\{\{ else \}\}/);
  const ar = branches[0]?.split('{{ if eq $l "ar" }}')[1] ?? "";
  return lang === "ar" ? ar : lang === "en" ? (branches[1] ?? "") : (branches[2] ?? "").replace(/\{\{ end \}\}\s*$/, "");
}

describe("gabarits d'authentification : une langue par message, choisie par Supabase Auth", () => {
  it("les fichiers générés sont ceux que la source produit (pnpm email:templates)", () => {
    expect(read("supabase/templates/confirmation.html")).toBe(renderConfirmationTemplate());
    expect(read("supabase/templates/recovery.html")).toBe(renderRecoveryTemplate());
    const config = read("supabase/config.toml");
    expect(config).toContain(`subject = '${renderConfirmationSubject()}'`);
    expect(config).toContain(`subject = '${renderRecoverySubject()}'`);
  });

  it.each([
    ["confirmation", renderConfirmationTemplate(), CONFIRMATION_ACTION_HREF, "signup"],
    ["recovery", renderRecoveryTemplate(), RECOVERY_ACTION_HREF, "recovery"],
  ])("%s : le choix de langue vient de user_metadata.locale ; français par défaut", (_name, html) => {
    expect(html.startsWith('{{- $l := "" }}{{ with .Data.locale }}{{ $l = . }}{{ end -}}')).toBe(true);
    expect(html).toContain('{{ if eq $l "ar" }}');
    expect(html).toContain('{{ else if eq $l "en" }}');
    expect(html).toContain("{{ else }}");
  });

  it.each([
    ["confirmation", renderConfirmationTemplate(), CONFIRMATION_ACTION_HREF, "signup"],
    ["recovery", renderRecoveryTemplate(), RECOVERY_ACTION_HREF, "recovery"],
  ])("%s : chaque variante a logo, bouton, une seule langue et le pied « Tous droits réservés »", (_name, template, href, type) => {
    const footers = { fr: "Tous droits réservés.", ar: "جميع الحقوق محفوظة.", en: "All rights reserved." };
    for (const lang of EMAIL_LANGS) {
      const html = variant(template, lang);
      expect(html, lang).toContain(`src="${AUTH_LOGO_URL}"`);
      expect(html, lang).toContain(`href="${href}"`);
      expect(html, lang).toContain(`type=${type}`);
      expect(html, lang).toContain(`<html lang="${lang}"`);
      expect(html, lang).toContain(`© Fusion Leap AI Growth. ${footers[lang]}`);
      // aucune autre langue dans la variante
      for (const other of EMAIL_LANGS) if (other !== lang) expect(html, `${lang} contient ${other}`).not.toContain(footers[other]);
      expect(lang === "ar" ? html.includes('dir="rtl"') : !html.includes('dir="rtl"')).toBe(true);
    }
  });

  it("pied en barre de couleur à texte blanc en gras ; pas de date dans les gabarits statiques", () => {
    for (const html of [renderConfirmationTemplate(), renderRecoveryTemplate()]) {
      expect(html).toMatch(/bgcolor="#ae2b2f"[^>]*>\s*<p[^>]*color:#ffffff/);
      expect(html).not.toMatch(/UTC/);
    }
  });

  it("aucun secret ni URL en dur : seules les variables de Supabase Auth et l'adresse du logo", () => {
    for (const html of [renderConfirmationTemplate(), renderRecoveryTemplate()]) {
      expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
      expect(html).not.toMatch(/127\.0\.0\.1|localhost/);
    }
  });

  it("l'objet suit la même langue", () => {
    expect(renderConfirmationSubject()).toContain("Confirmez votre adresse e-mail");
    expect(renderConfirmationSubject()).toContain("Confirm your email address");
    expect(renderConfirmationSubject()).toContain("أكِّد عنوان بريدك الإلكتروني");
    expect(renderRecoverySubject()).toContain("Réinitialisez votre mot de passe");
  });
});

describe("message de test SMTP : langue de l'administrateur", () => {
  it.each([
    ["fr", "Test de la configuration SMTP", "Tous droits réservés.", "7 novembre 2026 | 14:34:50 UTC"],
    ["en", "SMTP configuration test", "All rights reserved.", "7 November 2026 | 14:34:50 UTC"],
    ["ar", "اختبار إعدادات SMTP", "جميع الحقوق محفوظة.", "14:34:50 UTC"],
  ] as const)("%s : une seule langue, logo joint, année, signature et date", (lang, title, footer, date) => {
    const mail = renderSmtpTestEmail(NOW, lang);
    expect(mail.html).toContain(`<html lang="${lang}"`);
    expect(mail.html).toContain(title);
    expect(mail.html).toContain(`src="cid:${SMTP_TEST_LOGO_CID}"`);
    expect(mail.html).toContain(`© 2026 Fusion Leap AI Growth. ${footer}`);
    expect(mail.html).toContain(date);
    expect(mail.html).toMatch(/align="left"[^>]*>Fusion Leap AI Growth<\/td>/);
    expect(mail.html).not.toContain("<a ");
    expect(mail.text).toContain(title);
    expect(mail.text).toContain(`© 2026 Fusion Leap AI Growth. ${footer}`);
    expect(mail.subject).toBe(`Fusion Leap AI Growth : ${title}`);
    // jamais les deux autres langues
    for (const other of EMAIL_LANGS) {
      if (other === lang) continue;
      expect(mail.html).not.toContain(renderSmtpTestEmail(NOW, other).subject.split(" : ")[1] ?? "###");
    }
  });
});

describe("gabarit", () => {
  it("échappe le texte inséré", () => {
    expect(escapeHtml(`<b>"a" & b</b>`)).toBe("&lt;b&gt;&quot;a&quot; &amp; b&lt;/b&gt;");
    const html = renderEmailHtml({ lang: "fr", documentTitle: "<x>", copy: { title: "<script>", body: "b" }, logoSrc: "cid:x" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<a ");
  });

  it("version texte : lien présent quand il y a un bouton", () => {
    const text = renderEmailText({ lang: "fr", copy: { title: "T", body: "B", button: "Aller" }, actionHref: "https://exemple.test/x" });
    expect(text).toContain("Aller : https://exemple.test/x");
  });

  it("isEmailLang n'accepte que fr, ar, en", () => {
    expect(isEmailLang("ar")).toBe(true);
    expect(isEmailLang("de")).toBe(false);
    expect(isEmailLang(undefined)).toBe(false);
  });
});
