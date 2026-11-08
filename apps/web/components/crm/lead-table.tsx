import type { AuthLocale, LeadListRow, PipelineStageRow } from "@fusion-leap/domain";
import { TargetIcon } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Props = {
  locale: AuthLocale;
  rows: readonly LeadListRow[];
  /** Identifiant de l'utilisateur connecté (« Moi »). */
  userId: string;
  filtered: boolean;
};

const KNOWN_SOURCES = ["web_form", "csv_import", "manual"] as const;
const isKnownSource = (value: string): value is (typeof KNOWN_SOURCES)[number] => (KNOWN_SOURCES as readonly string[]).includes(value);
const shortIdOf = (userId: string): string => userId.replace(/-/g, "").slice(-6).toUpperCase();
const BADGE_VARIANT: Record<PipelineStageRow["kind"], "success" | "outline" | "secondary" | "destructive"> = {
  open: "secondary",
  won: "success",
  lost: "destructive",
  unassigned: "outline",
};

/**
 * Tableau des leads. Les coordonnées (e-mail, téléphone) sont isolées en `dir="ltr"` : elles se lisent de gauche à droite même dans
 * une page arabe. Le nom et l'étape sont des textes saisis : `<bdi>` évite qu'ils perturbent le texte voisin.
 */
export async function LeadTable({ locale, rows, userId, filtered }: Props) {
  const t = await getTranslations({ locale, namespace: "Crm" });
  const format = await getFormatter({ locale });
  // source connue : libellé traduit ; source inconnue (ex. connecteur futur) : le code tel quel
  const sourceLabel = (source: string) => (isKnownSource(source) ? t(`sources.${source}`) : source);

  if (rows.length === 0) {
    return (
      <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center text-sm">
        <TargetIcon className="size-6" aria-hidden="true" />
        <p>{filtered ? t("leads.emptyFiltered") : t("leads.empty")}</p>
      </div>
    );
  }

  return (
    <Table aria-labelledby="leads-title" className="min-w-[48rem]">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t("table.contact")}</TableHead>
          <TableHead scope="col">{t("table.email")}</TableHead>
          <TableHead scope="col">{t("table.phone")}</TableHead>
          <TableHead scope="col">{t("table.source")}</TableHead>
          <TableHead scope="col">{t("table.stage")}</TableHead>
          <TableHead scope="col">{t("table.assignee")}</TableHead>
          <TableHead scope="col">{t("table.created")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="font-medium">
              <bdi>{row.contact_name ?? t("table.noName")}</bdi>
            </TableCell>
            <TableCell>{row.contact_email ? <bdi dir="ltr">{row.contact_email}</bdi> : null}</TableCell>
            <TableCell>{row.contact_phone ? <bdi dir="ltr">{row.contact_phone}</bdi> : null}</TableCell>
            <TableCell>{sourceLabel(row.source)}</TableCell>
            <TableCell>
              <Badge variant={BADGE_VARIANT[row.stage_kind]}>
                <bdi>{row.stage_name}</bdi>
              </Badge>
            </TableCell>
            <TableCell>
              {row.assignee_id === null
                ? t("assignee.none")
                : row.assignee_id === userId
                  ? t("assignee.me")
                  : t("assignee.member", { id: shortIdOf(row.assignee_id) })}
            </TableCell>
            <TableCell>{format.dateTime(new Date(row.created_at), { dateStyle: "medium" })}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
