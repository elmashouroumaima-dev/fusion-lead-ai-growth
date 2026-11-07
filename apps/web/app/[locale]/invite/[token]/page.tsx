import { invitationTokenSchema } from "@fusion-leap/domain";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AcceptInvitationForm } from "../../../../components/members/accept-invitation-form";
import { requireLocale } from "../../../../i18n/require-locale";
import { requireClaims } from "../../../../lib/auth/require-claims";

export const dynamic = "force-dynamic";

// Le jeton est dans l'URL : pas d'indexation, pas de Referer sortant (les en-têtes HTTP équivalents
// sont posés par next.config.ts).
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type Props = { params: Promise<{ locale: string; token: string }> };

/**
 * Page d'acceptation d'une invitation. Volontairement HORS du groupe (app) : un utilisateur sans
 * organisation ne doit pas être renvoyé vers l'onboarding. Carte neutre : aucun nom d'organisation
 * ni de rôle avant l'acceptation, et un seul message d'erreur générique quelle que soit la cause.
 * Le jeton n'est ni journalisé ni affiché.
 */
export default async function InvitePage({ params }: Props) {
  const { token } = await params;
  const locale = await requireLocale(params);
  const t = await getTranslations({ locale, namespace: "Invite" });
  // Session requise : sans elle le proxy renvoie déjà vers /login ; ceci couvre son contournement.
  await requireClaims(locale);

  const parsed = invitationTokenSchema.safeParse(token);

  return (
    <section className="card">
      <h1>{t("title")}</h1>
      {parsed.success ? (
        <>
          <p className="lead">{t("description")}</p>
          <AcceptInvitationForm token={parsed.data} />
          <p className="hint">{t("hint")}</p>
        </>
      ) : (
        <p role="alert" className="notice notice-error">
          {t("errors.invitation_invalid")}
        </p>
      )}
    </section>
  );
}
