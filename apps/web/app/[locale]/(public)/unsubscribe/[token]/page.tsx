import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import {
  PageCard,
  PageCardContent,
  PageCardDescription,
  PageCardHeader,
  PageCardTitle,
} from "../../../../../components/public/page-card";
import { requireLocale } from "../../../../../i18n/require-locale";
import { isValidUnsubscribeToken } from "../../../../../lib/service/unsubscribe";
import { confirmUnsubscribeAction } from "../../../../../lib/unsubscribe/actions";

export const dynamic = "force-dynamic";
// le jeton est dans l'adresse : ni indexation, ni fuite par l'en-tête Referer
export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };

type Props = { params: Promise<{ locale: string; token: string }>; searchParams: Promise<{ result?: string }> };

/**
 * Page publique de désabonnement (J33) : ouvrir le lien ne désabonne pas, il faut confirmer (les analyseurs de liens des messageries
 * ouvrent les liens). Textes génériques : rien ne révèle l'adresse, l'entreprise ni l'existence d'un compte.
 */
export default async function UnsubscribePage({ params, searchParams }: Props) {
  const { token } = await params;
  const locale = await requireLocale(params);
  const { result } = await searchParams;
  const t = await getTranslations({ locale, namespace: "Unsubscribe" });

  const valid = isValidUnsubscribeToken(token);
  const state = !valid || result === "invalid" ? "invalid" : result === "done" ? "done" : result === "error" ? "error" : "confirm";

  return (
    <PageCard>
      <PageCardHeader>
        <PageCardTitle>{t(`${state}.title`)}</PageCardTitle>
        <PageCardDescription>{t(`${state}.description`)}</PageCardDescription>
      </PageCardHeader>
      {state === "confirm" || state === "error" ? (
        <PageCardContent>
          <form action={confirmUnsubscribeAction.bind(null, locale, token)}>
            <Button type="submit" className="w-full">
              {t(state === "error" ? "error.retry" : "confirm.submit")}
            </Button>
          </form>
        </PageCardContent>
      ) : null}
    </PageCard>
  );
}
