import { can } from "@fusion-leap/permissions";
import type { ReactNode } from "react";
import { MembersNav } from "../../../components/members/members-nav";
import { OrganizationSwitcher } from "../../../components/org/organization-switcher";
import styles from "../../../components/org/organization.module.css";
import { SwitcherSlot } from "../../../components/org/switcher-slot";
import { requireLocale } from "../../../i18n/require-locale";
import { requireClaims } from "../../../lib/auth/require-claims";
import { readActiveOrgCookie } from "../../../lib/tenant/active-org-cookie";
import { listMyMemberships, type ActiveMembership } from "../../../lib/tenant/memberships";
import { resolveActiveMembership } from "../../../lib/tenant/resolve";

type Props = {
  children: ReactNode;
  params: Promise<{ locale: string }>;
};

/** Le sélecteur est une commodité : une erreur de lecture ne doit jamais bloquer la page. */
async function loadSwitchable(): Promise<ActiveMembership[]> {
  try {
    const memberships = await listMyMemberships();
    return memberships.filter((m) => m.organization.status === "active");
  } catch {
    return [];
  }
}

/** Défense en profondeur : vérifie la session même si le proxy est contourné. */
export default async function AppLayout({ children, params }: Props) {
  const locale = await requireLocale(params);
  await requireClaims(locale);

  const switchable = await loadSwitchable();
  // Le cookie n'est qu'un indice d'affichage : seul un id présent dans MES adhésions est retenu.
  const hint = switchable.length >= 2 ? await readActiveOrgCookie() : undefined;
  const selectedId = switchable.find((m) => m.organizationId === hint)?.organizationId;

  // Lien « Membres » : seulement si le rôle de l'organisation active (relu en base) peut lister les membres.
  // Simple commodité d'affichage : la page et les actions revérifient tout. Échec de résolution = pas de lien.
  let showMembers = false;
  try {
    const active = resolveActiveMembership(switchable, await readActiveOrgCookie());
    showMembers = can(active.role, "list", "members");
  } catch {
    showMembers = false;
  }

  // Structure stable (même arbre quel que soit le nombre d'organisations ou la page) : les enfants
  // ne sont pas remontés quand le sélecteur apparaît ou disparaît.
  return (
    <div className={styles.appShell}>
      {switchable.length >= 2 || showMembers ? (
        <SwitcherSlot>
          {showMembers ? <MembersNav /> : null}
          {switchable.length >= 2 ? (
            <OrganizationSwitcher
              options={switchable.map((m) => ({ id: m.organizationId, name: m.organization.name }))}
              selectedId={selectedId}
            />
          ) : null}
        </SwitcherSlot>
      ) : null}
      {children}
    </div>
  );
}
