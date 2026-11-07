"use client";

import { LayoutDashboardIcon, PaletteIcon, ShieldIcon, UsersIcon } from "lucide-react";
import { useTranslations } from "next-intl";
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
  SidebarRail,
} from "@/components/ui/sidebar";
import { Link, usePathname } from "../../i18n/navigation";

type NavItem = { href: "/dashboard" | "/members" | "/settings/appearance" | "/admin/organizations"; labelKey: "dashboard" | "members" | "settings" | "admin"; icon: typeof UsersIcon };

const isCurrent = (pathname: string, href: string): boolean => pathname === href || pathname.startsWith(`${href}/`);

/**
 * Barre latérale de l'application (repliable en icônes, tiroir sur mobile). Le côté est logique :
 * elle suit la direction du document (à droite en arabe). « Membres » n'apparaît que si le layout
 * (serveur) a établi que le rôle actif peut les lister ; la page et les actions revérifient tout.
 */
export function AppSidebar({ showMembers, showSettings = false, showAdmin = false }: { showMembers: boolean; showSettings?: boolean; showAdmin?: boolean }) {
  const t = useTranslations("Shell");
  const pathname = usePathname();

  const items: NavItem[] = [
    { href: "/dashboard", labelKey: "dashboard", icon: LayoutDashboardIcon },
    ...(showMembers ? [{ href: "/members", labelKey: "members", icon: UsersIcon } satisfies NavItem] : []),
    ...(showSettings ? [{ href: "/settings/appearance", labelKey: "settings", icon: PaletteIcon } satisfies NavItem] : []),
    ...(showAdmin ? [{ href: "/admin/organizations", labelKey: "admin", icon: ShieldIcon } satisfies NavItem] : []),
  ];

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
                <Brand markClassName="size-8" textClassName="group-data-[collapsible=icon]:hidden" />
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
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
