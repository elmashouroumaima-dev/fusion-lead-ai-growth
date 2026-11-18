import type { AuthLocale } from "@fusion-leap/domain";
import { LockIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * Paramétrage global (palette, logo) : message lecture seule pour tout utilisateur qui n'est pas administrateur de
 * la plateforme (ADR 016). Aucun éditeur n'est rendu et aucune valeur n'est lue. Commodité d'affichage :
 * la base refuse de toute façon l'écriture (set_platform_config / reset_platform_config).
 */
export async function RestrictedNotice({ locale }: { locale: AuthLocale }) {
  const t = await getTranslations({ locale, namespace: "Settings" });
  return (
    <Alert role="status">
      <LockIcon aria-hidden="true" />
      <AlertTitle>{t("restricted.title")}</AlertTitle>
      <AlertDescription>
        <p>{t("restricted.body")}</p>
      </AlertDescription>
    </Alert>
  );
}
