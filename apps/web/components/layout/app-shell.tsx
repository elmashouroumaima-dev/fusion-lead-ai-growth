"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Brand } from "@/components/brand/logo";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { LanguageSwitcher } from "@/components/layout/language-switcher";
import { UserMenu } from "@/components/layout/user-menu";
import { OrganizationSwitcher } from "@/components/org/organization-switcher";
import { isSwitcherHiddenPath, SwitcherSlot } from "@/components/org/switcher-slot";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Link, usePathname } from "../../i18n/navigation";

export type AppShellProps = {
  children: ReactNode;
  /** Adresse e-mail des claims vérifiés (affichage seulement). */
  email: string | null;
  /** Lien « Membres » : décidé côté serveur (`can(role, "list", "members")`). */
  showMembers: boolean;
  showSettings?: boolean;
  showAdmin?: boolean;
  /** Organisations actives de l'utilisateur ; le sélecteur n'apparaît qu'à partir de deux. */
  organizations: readonly { id: string; name: string }[];
  selectedOrganizationId?: string | undefined;
  /** Nom de l'organisation active (fil d'Ariane), si elle a pu être résolue. */
  activeOrganizationName?: string | undefined;
};

type PageKey = "dashboard" | "projects" | "members" | "settings" | "admin" | "onboarding" | "selectOrganization";

function pageKeyOf(pathname: string): PageKey | null {
  const is = (base: string) => pathname === base || pathname.startsWith(`${base}/`);
  if (is("/dashboard")) return "dashboard";
  if (is("/projects")) return "projects";
  if (is("/members")) return "members";
  if (is("/settings")) return "settings";
  if (is("/admin")) return "admin";
  if (is("/onboarding")) return "onboarding";
  if (is("/select-organization")) return "selectOrganization";
  return null;
}

/**
 * Coquille de l'application (routes `(app)`) : barre latérale repliable + en-tête (fil d'Ariane,
 * sélecteur d'organisation, langue, thème, compte). Sur les pages d'onboarding et de sélection, aucune
 * navigation d'organisation : un en-tête réduit et le contenu centré.
 */
export function AppShell({ children, email, showMembers, showSettings = false, showAdmin = false, organizations, selectedOrganizationId, activeOrganizationName }: AppShellProps) {
  const t = useTranslations("Shell");
  const pathname = usePathname();
  const chromeless = isSwitcherHiddenPath(pathname);
  const pageKey = pageKeyOf(pathname);
  const pageLabel = pageKey === null ? null : pageKey === "dashboard" || pageKey === "projects" || pageKey === "members" || pageKey === "settings" || pageKey === "admin" ? t(`nav.${pageKey}`) : t(`pages.${pageKey}`);

  const switcher =
    organizations.length >= 2 ? <OrganizationSwitcher options={organizations} selectedId={selectedOrganizationId} /> : null;

  if (chromeless) {
    return (
      <div className="flex min-h-svh flex-col">
        <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <Link href="/" className="text-foreground rounded-md">
            <Brand />
          </Link>
          <div className="flex items-center gap-1">
            <LanguageSwitcher />
            <ThemeToggle />
            <UserMenu email={email} />
          </div>
        </header>
        <main id="main" className="flex flex-1 items-start justify-center px-4 py-8">
          {children}
        </main>
      </div>
    );
  }

  return (
    <SidebarProvider>
      <AppSidebar showMembers={showMembers} showSettings={showSettings} showAdmin={showAdmin} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="bg-background/95 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b px-4 backdrop-blur">
          <SidebarTrigger label={t("sidebar.toggle")} className="-ms-1" />
          <Separator orientation="vertical" className="me-1 h-5" />
          <Breadcrumb aria-label={t("breadcrumb.label")} className="min-w-0 flex-1">
            <BreadcrumbList className="flex-nowrap">
              {activeOrganizationName ? (
                <>
                  <BreadcrumbItem className="hidden min-w-0 sm:inline-flex">
                    <bdi className="max-w-48 truncate">{activeOrganizationName}</bdi>
                  </BreadcrumbItem>
                  {pageLabel ? <BreadcrumbSeparator className="hidden sm:block" /> : null}
                </>
              ) : null}
              {pageLabel ? (
                <BreadcrumbItem className="min-w-0">
                  <BreadcrumbPage className="truncate">{pageLabel}</BreadcrumbPage>
                </BreadcrumbItem>
              ) : null}
            </BreadcrumbList>
          </Breadcrumb>
          <div className="flex items-center gap-1">
            {switcher ? <SwitcherSlot>{switcher}</SwitcherSlot> : null}
            <LanguageSwitcher />
            <ThemeToggle />
            <UserMenu email={email} />
          </div>
        </header>
        <SidebarInset id="main" className="p-4 md:p-6">
          {children}
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
