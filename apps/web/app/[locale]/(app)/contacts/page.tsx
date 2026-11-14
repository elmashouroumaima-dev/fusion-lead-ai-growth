import { localeSchema } from "@fusion-leap/domain";
import { can } from "@fusion-leap/permissions";
import { ChevronLeftIcon, ChevronRightIcon, ContactRoundIcon, SearchIcon } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Link } from "../../../../i18n/navigation";
import { requireLocale } from "../../../../i18n/require-locale";
import { requireClaims } from "../../../../lib/auth/require-claims";
import { searchContacts, type ContactPage } from "../../../../lib/contacts/queries";
import { createClient } from "../../../../lib/supabase/server";
import { requireTenantContext } from "../../../../lib/tenant/context";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const QUERY_MAX = 100;
const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/** Recherche saisie : texte rogné, 100 caractères au plus ; vide = pas de filtre. */
function parseQuery(value: string | undefined): string | null {
  const text = (value ?? "").trim().slice(0, QUERY_MAX);
  return text === "" ? null : text;
}

function parsePage(value: string | undefined): number {
  const page = Number.parseInt(value ?? "1", 10);
  return Number.isInteger(page) && page >= 1 && page <= 100_000 ? page : 1;
}

const hrefFor = (query: string | null, page: number): string => {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  const text = params.toString();
  return text ? `/contacts?${text}` : "/contacts";
};

/**
 * Liste des contacts de l'entreprise active (J30b) : recherche (nom, e-mail, téléphone) et pagination CÔTÉ SERVEUR par `search_contacts`
 * (SECURITY INVOKER : la RLS décide de ce qui est visible). Rôles : owner, admin et marketing ; le commercial et l'analyste sont
 * renvoyés au tableau de bord (données personnelles).
 */
export default async function ContactsPage({ params, searchParams }: Props) {
  const locale = localeSchema.parse(await requireLocale(params));
  const t = await getTranslations({ locale, namespace: "Contacts" });
  await requireClaims(locale);
  const ctx = await requireTenantContext(locale);
  if (!can(ctx.role, "read", "contacts")) redirect(`/${locale}/dashboard`);

  const raw = await searchParams;
  const query = parseQuery(first(raw.q));
  const page = parsePage(first(raw.page));

  let loaded: ContactPage | null = null;
  try {
    loaded = await searchContacts(await createClient(), ctx.organizationId, query, page);
  } catch {
    loaded = null;
  }

  const format = await getFormatter({ locale });

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-6xl gap-6">
      <header className="grid gap-1">
        <h1 id="contacts-title" className="text-2xl font-semibold tracking-tight md:text-3xl">
          {t("title")}
        </h1>
        <p className="text-muted-foreground max-w-prose text-sm">{t("description")}</p>
      </header>

      <Card>
        <CardContent>
          <form action={`/${locale}/contacts`} method="get" role="search" className="flex flex-wrap items-end gap-3">
            <div className="grid min-w-0 flex-1 gap-1.5 sm:max-w-md">
              <label htmlFor="contacts-q" className="text-sm leading-none font-medium">
                {t("search.label")}
              </label>
              <Input id="contacts-q" name="q" type="search" defaultValue={query ?? ""} maxLength={QUERY_MAX} placeholder={t("search.placeholder")} />
            </div>
            <Button type="submit">
              <SearchIcon aria-hidden="true" />
              {t("search.submit")}
            </Button>
            {query ? (
              <Button asChild variant="ghost">
                <Link href="/contacts">{t("search.reset")}</Link>
              </Button>
            ) : null}
          </form>
        </CardContent>
      </Card>

      {loaded === null ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t("errors.load")}</AlertDescription>
        </Alert>
      ) : (
        <Card className="min-w-0">
          <CardContent className="grid min-w-0 gap-4">
            <p className="text-muted-foreground text-sm" role="status">
              {t("count", { count: format.number(loaded.total) })}
            </p>
            {loaded.rows.length === 0 ? (
              <div className="text-muted-foreground flex flex-col items-center gap-3 rounded-2xl border border-dashed p-10 text-center text-sm">
                <span className="bg-brand/15 text-primary-text grid size-12 place-items-center rounded-full">
                  <ContactRoundIcon className="size-6" aria-hidden="true" />
                </span>
                <p>{query ? t("emptyFiltered") : t("empty")}</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table aria-labelledby="contacts-title" className="min-w-[44rem]">
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">{t("table.contact")}</TableHead>
                      <TableHead scope="col">{t("table.email")}</TableHead>
                      <TableHead scope="col">{t("table.phone")}</TableHead>
                      <TableHead scope="col">{t("table.consent")}</TableHead>
                      <TableHead scope="col">{t("table.doNotContact")}</TableHead>
                      <TableHead scope="col">{t("table.created")}</TableHead>
                      <TableHead scope="col" className="text-end">
                        <span className="sr-only">{t("table.open")}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loaded.rows.map((contact) => {
                      const name = contact.name ?? t("table.unnamed");
                      return (
                        <TableRow key={contact.id}>
                          <TableCell className="font-medium">
                            <bdi>{name}</bdi>
                          </TableCell>
                          <TableCell>
                            <bdi dir="ltr">{contact.email_raw ?? "—"}</bdi>
                          </TableCell>
                          <TableCell>
                            <bdi dir="ltr">{contact.phone_e164 ?? "—"}</bdi>
                          </TableCell>
                          <TableCell>
                            <Badge variant={contact.consent_status === "granted" ? "success" : contact.consent_status === "revoked" ? "warning" : "outline"}>
                              {t(`status.${contact.consent_status}`)}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {contact.do_not_contact ? <Badge variant="destructive">{t("dnc.yes")}</Badge> : <span className="text-muted-foreground">{t("dnc.no")}</span>}
                          </TableCell>
                          <TableCell>{format.dateTime(new Date(contact.created_at), { dateStyle: "medium" })}</TableCell>
                          <TableCell className="text-end">
                            <Button asChild variant="ghost" size="sm">
                              <Link href={`/contacts/${contact.id}`} aria-label={t("table.openNamed", { name })}>
                                {t("table.open")}
                              </Link>
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
            {loaded.pageCount > 1 ? (
              <nav aria-label={t("pagination.label")} className="flex items-center justify-between gap-3">
                <Button asChild variant="outline" size="sm" className={loaded.page <= 1 ? "pointer-events-none opacity-50" : undefined}>
                  <Link href={hrefFor(query, loaded.page - 1)} aria-disabled={loaded.page <= 1} tabIndex={loaded.page <= 1 ? -1 : undefined} rel="prev">
                    <ChevronLeftIcon aria-hidden="true" className="rtl:rotate-180" />
                    {t("pagination.previous")}
                  </Link>
                </Button>
                <span className="text-muted-foreground text-sm">
                  {t("pagination.status", { page: format.number(loaded.page), pageCount: format.number(loaded.pageCount) })}
                </span>
                <Button asChild variant="outline" size="sm" className={loaded.page >= loaded.pageCount ? "pointer-events-none opacity-50" : undefined}>
                  <Link href={hrefFor(query, loaded.page + 1)} aria-disabled={loaded.page >= loaded.pageCount} tabIndex={loaded.page >= loaded.pageCount ? -1 : undefined} rel="next">
                    {t("pagination.next")}
                    <ChevronRightIcon aria-hidden="true" className="rtl:rotate-180" />
                  </Link>
                </Button>
              </nav>
            ) : null}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
