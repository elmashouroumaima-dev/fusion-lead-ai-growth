import type { AuthLocale, ProjectRow } from "@fusion-leap/domain";
import { FolderKanbanIcon } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Link } from "../../i18n/navigation";

type Props = { locale: AuthLocale; projects: readonly ProjectRow[]; archivedView: boolean };

/** Liste des projets de l'entreprise (lecture : tous les rôles). Le nom est un lien vers la page du projet. */
export async function ProjectList({ locale, projects, archivedView }: Props) {
  const t = await getTranslations({ locale, namespace: "Projects" });
  const format = await getFormatter({ locale });

  if (projects.length === 0) {
    return (
      <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center text-sm">
        <FolderKanbanIcon className="size-6" aria-hidden="true" />
        <p>{archivedView ? t("list.emptyArchived") : t("list.empty")}</p>
      </div>
    );
  }

  return (
    <Table aria-labelledby="projects-title" className="min-w-[36rem]">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t("table.name")}</TableHead>
          <TableHead scope="col">{t("table.type")}</TableHead>
          <TableHead scope="col">{t("table.status")}</TableHead>
          <TableHead scope="col">{t("table.updated")}</TableHead>
          <TableHead scope="col" className="text-end">
            {t("table.actions")}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {projects.map((project) => (
          <TableRow key={project.id}>
            <TableCell className="font-medium">
              <bdi>{project.name}</bdi>
            </TableCell>
            <TableCell>{t(`types.${project.type}`)}</TableCell>
            <TableCell>
              <Badge variant={project.status === "active" ? "success" : "outline"}>{t(`status.${project.status}`)}</Badge>
            </TableCell>
            <TableCell>{format.dateTime(new Date(project.updated_at), { dateStyle: "medium" })}</TableCell>
            <TableCell className="text-end">
              <Button asChild variant="ghost" size="sm">
                <Link href={`/projects/${project.id}`} aria-label={t("list.openNamed", { name: project.name })}>
                  {t("list.open")}
                </Link>
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
