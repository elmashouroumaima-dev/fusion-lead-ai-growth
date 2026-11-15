import { can } from "@fusion-leap/permissions";
import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { requireLocale } from "../../../i18n/require-locale";
import { isPlatformAdmin } from "../../../lib/admin/queries";
import { requireClaims } from "../../../lib/auth/require-claims";
import { createClient } from "../../../lib/supabase/server";
import { canManagePlatformConfig } from "../../../lib/settings/queries";
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
  const claims = await requireClaims(locale);
  const email = typeof claims.email === "string" ? claims.email : null;

  const switchable = await loadSwitchable();
  // Le cookie n'est qu'un indice d'affichage : seul un id présent dans MES adhésions est retenu.
  const hint = switchable.length >= 2 ? await readActiveOrgCookie() : undefined;
  const selectedId = switchable.find((m) => m.organizationId === hint)?.organizationId;

  // Lien « Membres » : seulement si le rôle de l'organisation active (relu en base) peut lister les membres.
  // Simple commodité d'affichage : la page et les actions revérifient tout. Échec de résolution = pas de lien.
  let showMembers = false;
  // Leads et deals : tout rôle qui lit les leads (le commercial lit les siens) ; l'analyste n'y a pas accès (PII). Commodité d'affichage.
  let showCrm = false;
  // Contacts et consentement : owner, admin et marketing (le commercial lit ses leads, pas la liste des contacts). Commodité d'affichage.
  let showContacts = false;
  // Boîte de réception : owner et admin (toutes les conversations) et commercial (les siennes). Commodité d'affichage.
  let showInbox = false;
  // Synchronisation CRM : owner et admin (matrice : état des intégrations). Commodité d'affichage.
  let showCrmSync = false;
  // Exploitation des envois (J39) : arrêt d'urgence (owner, admin, marketing) et dead letters (owner, admin). Commodité d'affichage.
  let showOperations = false;
  // Configuration (J39b) : règles d'assignation et notifications, owner et admin. Compteur de non lues = commodité d'affichage.
  let showConfig = false;
  let unreadNotifications = 0;
  // Paramétrage (palette globale) : owner / admin d'organisation seulement ; commodité d'affichage.
  const showSettings = await canManagePlatformConfig();
  // Administration de la plateforme (plans, abonnements) : administrateurs de la plateforme seulement.
  const showAdmin = await isPlatformAdmin();
  let activeOrganizationName: string | undefined;
  try {
    const active = resolveActiveMembership(switchable, await readActiveOrgCookie());
    showMembers = can(active.role, "list", "members");
    showCrm = can(active.role, "read", "leads", { isOwnRecord: true });
    showContacts = can(active.role, "read", "contacts");
    showInbox = can(active.role, "read", "conversations", { isOwnRecord: true });
    showCrmSync = can(active.role, "view_status", "integrations");
    showOperations = can(active.role, "emergency_stop", "sending") || can(active.role, "view", "dead_letter");
    showConfig = can(active.role, "manage", "assignment_rules");
    if (showConfig) {
      try {
        const counted = await (await createClient()).from("notifications").select("id", { count: "exact", head: true }).eq("organization_id", active.organizationId).is("read_at", null);
        unreadNotifications = counted.error ? 0 : (counted.count ?? 0);
      } catch {
        unreadNotifications = 0;
      }
    }
    activeOrganizationName = active.organization.name;
  } catch {
    showMembers = false;
    showCrm = false;
    showContacts = false;
    showInbox = false;
    showCrmSync = false;
    showOperations = false;
    showConfig = false;
    unreadNotifications = 0;
  }

  // Structure stable : la coquille ne dépend que de ces propriétés ; les enfants ne sont pas remontés
  // quand le sélecteur apparaît ou disparaît.
  return (
    <AppShell
      email={email}
      showMembers={showMembers}
      showCrm={showCrm}
      showContacts={showContacts}
      showInbox={showInbox}
      showCrmSync={showCrmSync}
      showOperations={showOperations}
      showConfig={showConfig}
      unreadNotifications={unreadNotifications}
      showSettings={showSettings}
      showAdmin={showAdmin}
      organizations={switchable.map((m) => ({ id: m.organizationId, name: m.organization.name }))}
      selectedOrganizationId={selectedId}
      activeOrganizationName={activeOrganizationName}
    >
      {children}
    </AppShell>
  );
}
