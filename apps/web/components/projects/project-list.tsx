import type { AuthLocale, ProjectRow, ProjectType } from "@fusion-leap/domain";
import { ArrowUpRightIcon, FolderKanbanIcon, GlobeIcon, PaletteIcon, PuzzleIcon, ShoppingBagIcon, type LucideIcon } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import { Link } from "../../i18n/navigation";

type Props = { locale: AuthLocale; projects: readonly ProjectRow[]; archivedView: boolean };

const TYPE_ICONS: Record<ProjectType, LucideIcon> = {
  website_sales: GlobeIcon,
  salla_app: ShoppingBagIcon,
  salla_theme: PaletteIcon,
  custom: PuzzleIcon,
};

/**
 * Projets de l'entreprise (lecture : tous les rôles) en cartes : icône du type, nom, statut, date de mise à jour. Toute la carte
 * est un lien vers la page du projet (nom accessible : « Ouvrir <nom> »).
 */
export async function ProjectList({ locale, projects, archivedView }: Props) {
  const t = await getTranslations({ locale, namespace: "Projects" });
  const format = await getFormatter({ locale });

  if (projects.length === 0) {
    return (
      <div className="text-muted-foreground flex flex-col items-center gap-3 rounded-2xl border border-dashed p-12 text-center text-sm">
        <span className="bg-brand/15 text-primary-text grid size-12 place-items-center rounded-full">
          <FolderKanbanIcon className="size-6" aria-hidden="true" />
        </span>
        <p>{archivedView ? t("list.emptyArchived") : t("list.empty")}</p>
      </div>
    );
  }

  return (
    <ul aria-labelledby="projects-title" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {projects.map((project) => {
        const Icon = TYPE_ICONS[project.type] ?? FolderKanbanIcon;
        return (
          <li key={project.id}>
            <Link
              href={`/projects/${project.id}`}
              aria-label={t("list.openNamed", { name: project.name })}
              className="bg-card text-card-foreground no-underline group focus-visible:ring-ring relative grid h-full gap-4 overflow-hidden rounded-xl border p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none motion-reduce:hover:translate-y-0"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="bg-brand/15 text-primary-text grid size-10 place-items-center rounded-lg">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <Badge variant={project.status === "active" ? "success" : "outline"}>{t(`status.${project.status}`)}</Badge>
              </div>
              <div className="grid gap-1">
                <h2 className="text-base leading-tight font-semibold">
                  <bdi>{project.name}</bdi>
                </h2>
                <p className="text-muted-foreground text-sm">{t(`types.${project.type}`)}</p>
              </div>
              <div className="text-muted-foreground flex items-center justify-between gap-2 border-t pt-3 text-xs">
                <span>
                  {t("table.updated")} {format.dateTime(new Date(project.updated_at), { dateStyle: "medium" })}
                </span>
                <ArrowUpRightIcon
                  className="text-primary-text size-4 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100 rtl:-scale-x-100"
                  aria-hidden="true"
                />
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
