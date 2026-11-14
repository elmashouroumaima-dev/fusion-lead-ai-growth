import { localeSchema, uuidSchema } from "@fusion-leap/domain";
import { can } from "@fusion-leap/permissions";
import { ArrowLeftIcon } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DoNotContactForm, RecordConsentForm, RevokeConsentForm } from "../../../../../components/contacts/consent-forms";
import { Link } from "../../../../../i18n/navigation";
import { requireLocale } from "../../../../../i18n/require-locale";
import { requireClaims } from "../../../../../lib/auth/require-claims";
import { getContact, listConsentEvents } from "../../../../../lib/contacts/queries";
import { createClient } from "../../../../../lib/supabase/server";
import { requireTenantContext } from "../../../../../lib/tenant/context";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string; id: string }> };

const KNOWN_SOURCES = ["manual", "phone", "in_person", "paper_form", "web_form", "csv_import"] as const;
const isKnownSource = (source: string): source is (typeof KNOWN_SOURCES)[number] => (KNOWN_SOURCES as readonly string[]).includes(source);

/** Texte de la preuve : seulement le texte et la version ; l'adresse IP et l'URL enregistrées ne sont jamais affichées. */
function proofOf(proof: Record<string, unknown>): { text: string | null; version: string | null } {
  return {
    text: typeof proof.consent_text === "string" && proof.consent_text !== "" ? proof.consent_text : null,
    version: typeof proof.consent_version === "string" && proof.consent_version !== "" ? proof.consent_version : null,
  };
}

/**
 * Fiche d'un contact (J30b) : coordonnées, statut du consentement, historique avec la preuve de chaque consentement, et formulaires
 * pour enregistrer / retirer un consentement et poser ou lever « ne plus contacter ». Rôles : owner, admin et marketing ; les autres
 * sont renvoyés au tableau de bord. Un contact d'une autre entreprise est introuvable (RLS).
 */
export default async function ContactPage({ params }: Props) {
  const { id: rawId } = await params;
  const locale = localeSchema.parse(await requireLocale(params));
  const t = await getTranslations({ locale, namespace: "Contacts" });
  await requireClaims(locale);
  const ctx = await requireTenantContext(locale);
  if (!can(ctx.role, "read", "contacts")) redirect(`/${locale}/dashboard`);
  const id = uuidSchema.safeParse(rawId);
  if (!id.success) notFound();

  const supabase = await createClient();
  let contact: Awaited<ReturnType<typeof getContact>> = null;
  let events: Awaited<ReturnType<typeof listConsentEvents>> = [];
  let failed = false;
  try {
    contact = await getContact(supabase, ctx.organizationId, id.data);
    if (contact) events = await listConsentEvents(supabase, ctx.organizationId, contact.id);
  } catch {
    failed = true;
  }
  if (!failed && !contact) notFound();

  const format = await getFormatter({ locale });
  const canWrite = can(ctx.role, "create", "contacts");
  // Lever « ne plus contacter » : owner et admin seulement (la base le revérifie).
  const canClear = ctx.role === "company_owner" || ctx.role === "company_admin";
  const common = { contactId: id.data, organizationId: ctx.organizationId };

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-4xl gap-6">
      <header className="grid gap-1">
        <Link href="/contacts" className="text-primary-text hover:bg-accent -ms-2 flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium">
          <ArrowLeftIcon className="size-4 rtl:-scale-x-100" aria-hidden="true" />
          {t("detail.back")}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          <bdi>{contact?.name ?? t("table.unnamed")}</bdi>
        </h1>
      </header>

      {failed || !contact ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t("errors.load")}</AlertDescription>
        </Alert>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <Card role="region" aria-labelledby="contact-identity-title">
              <CardHeader>
                <CardTitle id="contact-identity-title">
                  <h2>{t("detail.identity")}</h2>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">{t("detail.name")}</dt>
                  <dd className="font-medium">
                    <bdi>{contact.name ?? "—"}</bdi>
                  </dd>
                  <dt className="text-muted-foreground">{t("detail.email")}</dt>
                  <dd>
                    <bdi dir="ltr">{contact.email_raw ?? "—"}</bdi>
                  </dd>
                  <dt className="text-muted-foreground">{t("detail.phone")}</dt>
                  <dd>
                    <bdi dir="ltr">{contact.phone_e164 ?? "—"}</bdi>
                  </dd>
                  <dt className="text-muted-foreground">{t("detail.language")}</dt>
                  <dd>
                    <bdi dir="ltr">{contact.language ?? "—"}</bdi>
                  </dd>
                  <dt className="text-muted-foreground">{t("detail.country")}</dt>
                  <dd>
                    <bdi dir="ltr">{contact.country ?? "—"}</bdi>
                  </dd>
                  <dt className="text-muted-foreground">{t("detail.created")}</dt>
                  <dd>{format.dateTime(new Date(contact.created_at), { dateStyle: "medium" })}</dd>
                </dl>
              </CardContent>
            </Card>

            <Card role="region" aria-labelledby="contact-status-title">
              <CardHeader>
                <CardTitle id="contact-status-title">
                  <h2>{t("detail.status")}</h2>
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3">
                <div>
                  <Badge variant={contact.consent_status === "granted" ? "success" : contact.consent_status === "revoked" ? "warning" : "outline"}>
                    {t(`status.${contact.consent_status}`)}
                  </Badge>
                </div>
                <div className="grid gap-1 text-sm">
                  <span className="text-muted-foreground">{t("detail.doNotContact")}</span>
                  <div className="flex items-center gap-2">
                    {contact.do_not_contact ? <Badge variant="destructive">{t("dnc.yes")}</Badge> : <Badge variant="outline">{t("dnc.no")}</Badge>}
                  </div>
                  <p className="text-muted-foreground text-xs">{contact.do_not_contact ? t("detail.blocked") : t("detail.notBlocked")}</p>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card role="region" aria-labelledby="contact-history-title">
            <CardHeader>
              <CardTitle id="contact-history-title">
                <h2>{t("history.title")}</h2>
              </CardTitle>
              <CardDescription>{t("history.description")}</CardDescription>
            </CardHeader>
            <CardContent>
              {events.length === 0 ? (
                <p className="text-muted-foreground text-sm">{t("history.empty")}</p>
              ) : (
                <ul className="grid gap-3">
                  {events.map((event) => {
                    const proof = proofOf(event.proof);
                    return (
                      <li key={event.id} className="grid gap-2 rounded-xl border p-4 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="secondary">{t(`channels.${event.channel}`)}</Badge>
                          <span className="font-medium">{event.purpose === "marketing" || event.purpose === "newsletter" ? t(`purposes.${event.purpose}`) : event.purpose}</span>
                          {event.revoked_at ? (
                            <Badge variant="warning">{t("history.revokedOn", { date: format.dateTime(new Date(event.revoked_at), { dateStyle: "medium" }) })}</Badge>
                          ) : (
                            <Badge variant="success">{t("history.active")}</Badge>
                          )}
                        </div>
                        <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                          <dt>{t("history.captured")}</dt>
                          <dd>{format.dateTime(new Date(event.captured_at), { dateStyle: "medium", timeStyle: "short" })}</dd>
                          <dt>{t("history.source")}</dt>
                          <dd>{isKnownSource(event.source) ? t(`sources.${event.source}`) : event.source}</dd>
                          <dt>{t("history.proofText")}</dt>
                          <dd className="text-foreground">{proof.text ? <bdi>{proof.text}</bdi> : t("history.noProof")}</dd>
                          {proof.version ? (
                            <>
                              <dt>{t("history.proofVersion")}</dt>
                              <dd className="text-foreground">
                                <bdi dir="ltr">{proof.version}</bdi>
                              </dd>
                            </>
                          ) : null}
                        </dl>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          {canWrite ? (
            <div className="grid gap-4 md:grid-cols-2">
              <Card role="region" aria-labelledby="contact-record-title" className="md:col-span-2">
                <CardHeader>
                  <CardTitle id="contact-record-title">
                    <h2>{t("record.title")}</h2>
                  </CardTitle>
                  <CardDescription>{t("record.description")}</CardDescription>
                </CardHeader>
                <CardContent>
                  <RecordConsentForm {...common} idempotencyKey={crypto.randomUUID()} hasEmail={contact.email_normalized !== null} hasPhone={contact.phone_e164 !== null} />
                </CardContent>
              </Card>
              <Card role="region" aria-labelledby="contact-revoke-title">
                <CardHeader>
                  <CardTitle id="contact-revoke-title">
                    <h2>{t("revoke.title")}</h2>
                  </CardTitle>
                  <CardDescription>{t("revoke.description")}</CardDescription>
                </CardHeader>
                <CardContent>
                  <RevokeConsentForm {...common} idempotencyKey={crypto.randomUUID()} hasEmail={contact.email_normalized !== null} hasPhone={contact.phone_e164 !== null} />
                </CardContent>
              </Card>
              <Card role="region" aria-labelledby="contact-block-title">
                <CardHeader>
                  <CardTitle id="contact-block-title">
                    <h2>{t("block.title")}</h2>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <DoNotContactForm {...common} idempotencyKey={crypto.randomUUID()} blocked={contact.do_not_contact} canClear={canClear} />
                </CardContent>
              </Card>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
