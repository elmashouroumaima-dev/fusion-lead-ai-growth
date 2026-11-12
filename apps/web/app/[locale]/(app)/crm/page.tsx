import { localeSchema, type CrmMappingRow } from "@fusion-leap/domain";
import { can } from "@fusion-leap/permissions";
import { PlugZapIcon } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RetrySyncButton } from "../../../../components/crm-sync/retry-button";
import { requireLocale } from "../../../../i18n/require-locale";
import { requireClaims } from "../../../../lib/auth/require-claims";
import { listIntegrations } from "../../../../lib/crm-sync/service";
import { createClient } from "../../../../lib/supabase/server";
import { requireTenantContext } from "../../../../lib/tenant/context";

export const dynamic = "force-dynamic";

const STATUS_VARIANT = { never: "outline", queued: "secondary", running: "secondary", ok: "success", failed: "destructive" } as const;
const ERROR_CODES = ["file_missing", "file_malformed", "mapping_invalid", "failed"] as const;
const FIELDS = ["external_id", "external_updated_at", "email", "phone", "name", "language", "country"] as const;
const isErrorCode = (value: string): value is (typeof ERROR_CODES)[number] => (ERROR_CODES as readonly string[]).includes(value);
const isField = (value: string): value is (typeof FIELDS)[number] => (FIELDS as readonly string[]).includes(value);
const isProvider = (value: string): value is "csv" | "internal" => value === "csv" || value === "internal";

/**
 * Synchronisation CRM : intégrations de l'entreprise active, correspondance des champs (lecture) et ÉTAT de la dernière synchro avec
 * « Réessayer » en cas d'échec. Owner et admin seulement (la RLS et les fonctions SQL revérifient) ; les autres rôles sont renvoyés au
 * tableau de bord. Aucun secret ni contenu de fichier n'est affiché.
 */
export default async function CrmSyncPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = localeSchema.parse(await requireLocale(params));
  const t = await getTranslations({ locale, namespace: "CrmSync" });
  await requireClaims(locale);
  const ctx = await requireTenantContext(locale);
  if (!can(ctx.role, "view_status", "integrations")) redirect(`/${locale}/dashboard`);

  const format = await getFormatter({ locale });
  let views: Awaited<ReturnType<typeof listIntegrations>> | null = null;
  try {
    views = await listIntegrations(await createClient(), ctx.organizationId);
  } catch {
    views = null;
  }

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-5xl gap-6">
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground max-w-prose text-sm">{t("description")}</p>
        <p className="text-muted-foreground text-xs">{t("rule")}</p>
      </header>

      {views === null ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t("errors.failed")}</AlertDescription>
        </Alert>
      ) : views.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center text-sm">
          <PlugZapIcon className="size-6" aria-hidden="true" />
          <p>{t("empty")}</p>
        </div>
      ) : (
        views.map(({ integration, mappings, sync }) => {
          const name = isProvider(integration.provider) ? t(`providers.${integration.provider}`) : integration.provider;
          return (
            <Card key={integration.id} className="min-w-0">
              <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="grid gap-1">
                  <h2 className="text-lg leading-none font-semibold">
                    {name} <bdi dir="ltr" className="text-muted-foreground text-sm font-normal">({integration.external_account_id})</bdi>
                  </h2>
                  <p className="text-muted-foreground text-sm">
                    {t("lastSync")} : {sync.lastSyncAt ? format.dateTime(new Date(sync.lastSyncAt), { dateStyle: "medium", timeStyle: "short" }) : t("lastSyncNever")}
                  </p>
                </div>
                <div className="grid justify-items-start gap-2 sm:justify-items-end">
                  <Badge variant={STATUS_VARIANT[sync.status]}>
                    {t("status.label")} : {t(`status.${sync.status}`)}
                  </Badge>
                  {sync.status === "failed" ? <RetrySyncButton integrationId={integration.id} name={name} /> : null}
                </div>
              </CardHeader>
              <CardContent className="grid min-w-0 gap-4">
                {sync.lastError ? (
                  <Alert variant="destructive" role="alert">
                    <AlertDescription>
                      {t("lastError")} : {isErrorCode(sync.lastError) ? t(`errors.${sync.lastError}`) : t("errors.failed")}
                    </AlertDescription>
                  </Alert>
                ) : null}
                <h3 className="text-sm font-semibold">{t("mapping.title")}</h3>
                {mappings.length === 0 ? (
                  <p className="text-muted-foreground text-sm">{t("mapping.none")}</p>
                ) : (
                  <div className="overflow-x-auto">
                    <MappingTable locale={locale} rows={mappings} />
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}

async function MappingTable({ locale, rows }: { locale: "fr" | "ar" | "en"; rows: readonly CrmMappingRow[] }) {
  const t = await getTranslations({ locale, namespace: "CrmSync" });
  return (
    <Table className="min-w-[32rem]">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t("mapping.internal")}</TableHead>
          <TableHead scope="col">{t("mapping.external")}</TableHead>
          <TableHead scope="col">{t("mapping.truth")}</TableHead>
          <TableHead scope="col">{t("mapping.direction")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="font-medium">{isField(row.internal_field) ? t(`fields.${row.internal_field}`) : row.internal_field}</TableCell>
            <TableCell>
              <bdi>{row.external_field}</bdi>
            </TableCell>
            <TableCell>{t(`truth.${row.source_of_truth}`)}</TableCell>
            <TableCell>{t(`directions.${row.direction}`)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
