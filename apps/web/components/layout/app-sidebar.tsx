"use client";

import {
  ChevronDownIcon,
  CircleUserIcon,
  FolderKanbanIcon,
  KanbanSquareIcon,
  LayoutDashboardIcon,
  MailIcon,
  PaletteIcon,
  ShieldIcon,
  SlidersHorizontalIcon,
  TargetIcon,
  UsersIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Brand } from "@/components/brand/logo";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { Link, usePathname } from "../../i18n/navigation";

type NavItem = {
  href: "/dashboard" | "/projects" | "/leads" | "/deals" | "/members" | "/admin/organizations";
  labelKey: "dashboard" | "projects" | "leads" | "deals" | "members" | "admin";
  icon: typeof UsersIcon;
};

/** Sous-menu « Paramétrage » (liste déroulante). SMTP : administrateurs de la plateforme seulement. */
type SettingsLink = {
  href: "/settings/appearance" | "/settings/logo" | "/settings/smtp";
  labelKey: "settingsPalette" | "settingsLogo" | "settingsSmtp";
  icon: typeof UsersIcon;
};

const isCurrent = (pathname: string, href: string): boolean =>
  pathname === href || pathname.startsWith(`${href}/`);

/**
 * Barre latérale de l'application (repliable en icônes, tiroir sur mobile). Le côté est logique :
 * elle suit la direction du document (à droite en arabe). « Membres » n'apparaît que si le layout
 * (serveur) a établi que le rôle actif peut les lister ; la page et les actions revérifient tout.
 */
export function AppSidebar({
  showMembers,
  showCrm = false,
  showSettings = false,
  showAdmin = false,
}: {
  showMembers: boolean;
  /** « Leads » et « Deals » : rôles qui peuvent lire les leads (commodité d'affichage ; les pages et la RLS décident). */
  showCrm?: boolean;
  showSettings?: boolean;
  showAdmin?: boolean;
}) {
  const t = useTranslations("Shell");
  const pathname = usePathname();

  const items: NavItem[] = [
    { href: "/dashboard", labelKey: "dashboard", icon: LayoutDashboardIcon },
    { href: "/projects", labelKey: "projects", icon: FolderKanbanIcon },
    ...(showCrm
      ? [
          { href: "/leads", labelKey: "leads", icon: TargetIcon } satisfies NavItem,
          { href: "/deals", labelKey: "deals", icon: KanbanSquareIcon } satisfies NavItem,
        ]
      : []),
    ...(showMembers
      ? [{ href: "/members", labelKey: "members", icon: UsersIcon } satisfies NavItem]
      : []),
    ...(showAdmin
      ? [{ href: "/admin/organizations", labelKey: "admin", icon: ShieldIcon } satisfies NavItem]
      : []),
  ];

  const settingsLinks: SettingsLink[] = [
    { href: "/settings/appearance", labelKey: "settingsPalette", icon: PaletteIcon },
    { href: "/settings/logo", labelKey: "settingsLogo", icon: CircleUserIcon },
    ...(showAdmin
      ? [
          {
            href: "/settings/smtp",
            labelKey: "settingsSmtp",
            icon: MailIcon,
          } satisfies SettingsLink,
        ]
      : []),
  ];
  const onSettings = isCurrent(pathname, "/settings");
  // Ouvert d'office dans les pages de Paramétrage ; un clic sur le titre le replie ou le déplie ensuite.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const settingsOpen = toggled ?? onSettings;

  return (
    <Sidebar
      collapsible="icon"
      mobileTitle={t("sidebar.mobileTitle")}
      mobileDescription={t("sidebar.mobileDescription")}
      closeLabel={t("sidebar.close")}
    >
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/dashboard">
                <Brand
                  markClassName="size-8"
                  textClassName="group-data-[collapsible=icon]:hidden"
                />
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <nav aria-label={t("nav.label")}>
              <SidebarMenu>
                {items.map((item) => {
                  const label = t(`nav.${item.labelKey}`);
                  const active = isCurrent(pathname, item.href);
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton asChild isActive={active} tooltip={label}>
                        <Link href={item.href} aria-current={active ? "page" : undefined}>
                          <item.icon aria-hidden="true" />
                          <span>{label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
                {showSettings ? (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      type="button"
                      isActive={onSettings}
                      tooltip={t("nav.settings")}
                      aria-expanded={settingsOpen}
                      aria-controls="nav-settings-sub"
                      onClick={() => setToggled(!settingsOpen)}
                    >
                      <SlidersHorizontalIcon aria-hidden="true" />
                      <span>{t("nav.settings")}</span>
                      <ChevronDownIcon
                        aria-hidden="true"
                        className={`ms-auto transition-transform ${settingsOpen ? "rotate-180" : ""}`}
                      />
                    </SidebarMenuButton>
                    {settingsOpen ? (
                      <SidebarMenuSub
                        id="nav-settings-sub"
                        className="border-border ms-5 me-0 translate-x-0 gap-0.5 py-1 ps-2"
                      >
                        {settingsLinks.map((link) => {
                          const label = t(`nav.${link.labelKey}`);
                          const active = isCurrent(pathname, link.href);
                          return (
                            <SidebarMenuSubItem key={link.href}>
                              <SidebarMenuSubButton
                                asChild
                                isActive={active}
                                className="text-muted-foreground hover:text-foreground data-[active=true]:bg-primary/10 data-[active=true]:text-primary-text relative h-9 translate-x-0 gap-2.5 rounded-md px-3 text-sm font-normal data-[active=true]:font-medium data-[active=true]:before:absolute data-[active=true]:before:-start-[9px] data-[active=true]:before:inset-y-1.5 data-[active=true]:before:w-0.5 data-[active=true]:before:rounded-full data-[active=true]:before:bg-primary data-[active=true]:before:content-['']"
                              >
                                <Link href={link.href} aria-current={active ? "page" : undefined}>
                                  <link.icon aria-hidden="true" />
                                  <span>{label}</span>
                                </Link>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          );
                        })}
                      </SidebarMenuSub>
                    ) : null}
                  </SidebarMenuItem>
                ) : null}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
