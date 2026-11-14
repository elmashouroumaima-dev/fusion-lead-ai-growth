import { INTEGRATION_PROVIDERS, localeSchema } from "@fusion-leap/domain";
import { can } from "@fusion-leap/permissions";
import { KeyRoundIcon, PlugIcon } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { IntegrationActions } from "../../../../components/integrations/integration-actions";
import { requireLocale } from "../../../../i18n/require-locale";
import { requireClaims } from "../../../../lib/auth/require-claims";
import { isEncryptionConfigured, listIntegrationViews } from "../../../../lib/integrations/service";
import { createClient } from "../../../../lib/supabase/server";
import { requireTenantContext } from "../../../../lib/tenant/context";

export const dynamic = "force-dynamic";

const STATUS_VARIANT = { pending: "secondary", active: "success", error: "destructive", disconnected: "outline", disabled: "outline" } as const;
const isProvider = (value: string): value is (typeof INTEGRATION_PROVIDERS)[number] => (INTEGRATION_PROVIDERS as readonly string[]).includes(value);

/**
 * Intégrations de l'entreprise (J28) : statut, portée, dernière synchronisation, canaux, « Remplacer le jeton » et « Déconnecter ».
 * Owner et admin seulement (la RLS et les fonctions SQL revérifient) ; les autres rôles sont renvoyés au tableau de bord. AUCUN
 * secret n'est lu ni affiché : la page ne reçoit que `has_secret`. Le jeton est en écriture seule.
 */
export default async function IntegrationsPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = localeSchema.parse(await requireLocale(params));
  const t = await getTranslations({ locale, namespace: "Integrations" });
  await requireClaims(locale);
  const ctx = await requireTenantContext(locale);
  if (!can(ctx.role, "view_status", "integrations")) redirect(`/${locale}/dashboard`);

  const format = await getFormatter({ locale });
  const encryptionConfigured = isEncryptionConfigured();
  let views: Awaited<ReturnType<typeof listIntegrationViews>> | null = null;
  try {
    views = await listIntegrationViews(await createClient(), ctx.organizationId);
  } catch {
    views = null;
  }

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-5xl gap-6">
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground max-w-prose text-sm">{t("description")}</p>
      </header>

      {!encryptionConfigured ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t("encryptionOff")}</AlertDescription>
        </Alert>
      ) : null}

      {views === null ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t("loadFailed")}</AlertDescription>
        </Alert>
      ) : views.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center text-sm">
          <PlugIcon className="size-6" aria-hidden="true" />
          <p>{t("empty")}</p>
        </div>
      ) : (
        views.map(({ integration, channels }) => {
          const withSecret = integration.provider === "email" || integration.provider === "whatsapp";
          const name = isProvider(integration.provider) ? t(`providers.${integration.provider}`) : integration.provider;
          return (
            <Card key={integration.id} className="min-w-0">
              <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="grid gap-1">
                  <h2 className="text-lg leading-none font-semibold">
                    {name} <bdi dir="ltr" className="text-muted-foreground text-sm font-normal">({integration.external_account_id})</bdi>
                  </h2>
                  <p className="text-muted-foreground text-sm">
                    {t("lastSync")} : {integration.last_sync_at ? format.dateTime(new Date(integration.last_sync_at), { dateStyle: "medium", timeStyle: "short" }) : t("lastSyncNever")}
                  </p>
                </div>
                <Badge variant={STATUS_VARIANT[integration.status]}>
                  {t("status.label")} : {t(`status.${integration.status}`)}
                </Badge>
              </CardHeader>
              <CardContent className="grid min-w-0 gap-4">
                {integration.last_error ? (
                  <Alert variant="destructive" role="alert">
                    <AlertDescription>{t("lastError")}</AlertDescription>
                  </Alert>
                ) : null}

                <div className="grid gap-1 text-sm">
                  <span className="font-semibold">{t("scopes")}</span>
                  {integration.scopes.length === 0 ? (
                    <span className="text-muted-foreground">{t("scopesNone")}</span>
                  ) : (
                    <ul className="flex flex-wrap gap-1" dir="ltr">
                      {integration.scopes.map((scope) => (
                        <li key={scope}>
                          <Badge variant="outline">{scope}</Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {withSecret ? (
                  <>
                    <p className="flex items-center gap-2 text-sm">
                      <KeyRoundIcon className="size-4" aria-hidden="true" />
                      <span>{integration.has_secret ? t("secretStored") : t("secretMissing")}</span>
                    </p>
                    <p className="text-muted-foreground text-xs">{t("secretNote")}</p>
                    <div className="grid gap-1 text-sm">
                      <span className="font-semibold">{t("channels")}</span>
                      {channels.length === 0 ? (
                        <span className="text-muted-foreground">{t("channelsNone")}</span>
                      ) : (
                        <ul className="grid gap-1">
                          {channels.map((channel) => (
                            <li key={channel.id} className="flex flex-wrap items-center gap-2">
                              <bdi dir="ltr">{channel.sender_identity}</bdi>
                              <Badge variant="outline">{t(`channelStatus.${channel.send_paused && channel.status !== "disconnected" ? "paused" : channel.status}`)}</Badge>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <IntegrationActions integrationId={integration.id} encryptionConfigured={encryptionConfigured} disconnected={integration.status === "disconnected"} />
                  </>
                ) : (
                  <a href={`/${locale}/crm`} className="text-primary-text text-sm underline-offset-4 hover:underline">
                    {t("crmLink")}
                  </a>
                )}
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}
