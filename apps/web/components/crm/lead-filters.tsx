import { LEAD_SORTS, type AuthLocale, type LeadListFilters, type PipelineStageRow, type ProjectRow } from "@fusion-leap/domain";
import { SearchIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link } from "../../i18n/navigation";

type Props = {
  locale: AuthLocale;
  filters: LeadListFilters;
  projects: readonly Pick<ProjectRow, "id" | "name">[];
  stages: readonly Pick<PipelineStageRow, "id" | "name">[];
  sources: readonly string[];
  /** Responsables proposés (owner et admin seulement) : identifiant court opaque + rôle. */
  assignees: readonly { userId: string; label: string }[];
};

const KNOWN_SOURCES = ["web_form", "csv_import", "manual"] as const;
const isKnownSource = (value: string): value is (typeof KNOWN_SOURCES)[number] => (KNOWN_SOURCES as readonly string[]).includes(value);
const selectClass =
  "border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs outline-none focus-visible:ring-[3px] md:text-sm";

/**
 * Filtres et recherche de la liste des leads : un formulaire GET (aucun JavaScript requis), donc l'URL porte tous les filtres
 * (lien partageable, bouton Précédent, export identique). Les valeurs sont revalidées côté serveur (`parseLeadListParams`).
 */
export async function LeadFilters({ locale, filters, projects, stages, sources, assignees }: Props) {
  const t = await getTranslations({ locale, namespace: "Crm" });
  const sourceLabel = (source: string) => (isKnownSource(source) ? t(`sources.${source}`) : source);

  return (
    <form method="get" role="search" aria-label={t("filters.label")} className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="leads-q">{t("filters.search")}</Label>
        <div className="relative">
          <SearchIcon aria-hidden="true" className="text-muted-foreground pointer-events-none absolute inset-y-0 start-3 my-auto size-4" />
          <Input
            id="leads-q"
            name="q"
            type="search"
            defaultValue={filters.query ?? ""}
            placeholder={t("filters.searchPlaceholder")}
            maxLength={100}
            autoComplete="off"
            className="ps-9"
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="grid gap-1.5">
          <Label htmlFor="leads-project">{t("filters.project")}</Label>
          <select id="leads-project" name="project" defaultValue={filters.project ?? ""} className={selectClass}>
            <option value="">{t("filters.all")}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="leads-stage">{t("filters.stage")}</Label>
          <select id="leads-stage" name="stage" defaultValue={filters.stage ?? ""} className={selectClass}>
            <option value="">{t("filters.all")}</option>
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="leads-source">{t("filters.source")}</Label>
          <select id="leads-source" name="source" defaultValue={filters.source ?? ""} className={selectClass}>
            <option value="">{t("filters.all")}</option>
            {sources.map((source) => (
              <option key={source} value={source}>
                {sourceLabel(source)}
              </option>
            ))}
          </select>
        </div>
        {assignees.length > 0 ? (
          <div className="grid gap-1.5">
            <Label htmlFor="leads-assignee">{t("filters.assignee")}</Label>
            <select id="leads-assignee" name="assignee" defaultValue={filters.assignee ?? ""} className={selectClass}>
              <option value="">{t("filters.all")}</option>
              {assignees.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="grid gap-1.5">
          <Label htmlFor="leads-sort">{t("filters.sort")}</Label>
          <select id="leads-sort" name="sort" defaultValue={filters.sort} className={selectClass}>
            {LEAD_SORTS.map((sort) => (
              <option key={sort} value={sort}>
                {t(`sorts.${sort}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <input
            id="leads-unassigned"
            name="unassigned"
            type="checkbox"
            value="1"
            defaultChecked={filters.unassigned}
            className="accent-primary size-4 rounded border"
          />
          <Label htmlFor="leads-unassigned">{t("filters.unassigned")}</Label>
        </div>
        <div className="flex gap-2">
          <Button type="submit">{t("filters.apply")}</Button>
          <Button asChild variant="outline">
            <Link href="/leads">{t("filters.reset")}</Link>
          </Button>
        </div>
      </div>
    </form>
  );
}
