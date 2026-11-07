import type { ReactNode } from "react";
import { OrganizationSwitcher } from "../../../components/org/organization-switcher";
import styles from "../../../components/org/organization.module.css";
import { SwitcherSlot } from "../../../components/org/switcher-slot";
import { requireLocale } from "../../../i18n/require-locale";
import { requireClaims } from "../../../lib/auth/require-claims";
import { readActiveOrgCookie } from "../../../lib/tenant/active-org-cookie";
import { listMyMemberships, type ActiveMembership } from "../../../lib/tenant/memberships";

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

  // Structure stable (même arbre quel que soit le nombre d'organisations ou la page) : les enfants
  // ne sont pas remontés quand le sélecteur apparaît ou disparaît.
  return (
    <div className={styles.appShell}>
      {switchable.length >= 2 ? (
        <SwitcherSlot>
          <OrganizationSwitcher
            options={switchable.map((m) => ({ id: m.organizationId, name: m.organization.name }))}
            selectedId={selectedId}
          />
        </SwitcherSlot>
      ) : null}
      {children}
    </div>
  );
}
