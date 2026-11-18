/**
 * Page courante de la coquille (fil d'Ariane) : la clé choisit le libellé `Shell.nav.<clé>` (pages de la navigation) ou `Shell.pages.<clé>` (pages sans entrée
 * de navigation). Une route absente d'ici laisse le fil d'Ariane VIDE : toute nouvelle page de la navigation doit être ajoutée ici (le test le vérifie).
 */
export const NAV_PAGE_KEYS = [
  "dashboard",
  "projects",
  "leads",
  "contacts",
  "inbox",
  "deals",
  "crmSync",
  "integrations",
  "operations",
  "assignment",
  "notifications",
  "imports",
  "members",
  "settings",
  "admin",
] as const;
export const OTHER_PAGE_KEYS = ["onboarding", "selectOrganization"] as const;
export type NavPageKey = (typeof NAV_PAGE_KEYS)[number];
export type PageKey = NavPageKey | (typeof OTHER_PAGE_KEYS)[number];

export const isNavPageKey = (key: PageKey): key is NavPageKey => (NAV_PAGE_KEYS as readonly string[]).includes(key);

/** Préfixe d'URL (sans la langue) de chaque page. */
const ROUTES: ReadonlyArray<readonly [string, PageKey]> = [
  ["/dashboard", "dashboard"],
  ["/projects", "projects"],
  ["/leads", "leads"],
  ["/contacts", "contacts"],
  ["/inbox", "inbox"],
  ["/deals", "deals"],
  ["/crm", "crmSync"],
  ["/integrations", "integrations"],
  ["/operations", "operations"],
  ["/assignment", "assignment"],
  ["/notifications", "notifications"],
  ["/imports", "imports"],
  ["/members", "members"],
  ["/settings", "settings"],
  ["/admin", "admin"],
  ["/onboarding", "onboarding"],
  ["/select-organization", "selectOrganization"],
];

export function pageKeyOf(pathname: string): PageKey | null {
  for (const [base, key] of ROUTES) if (pathname === base || pathname.startsWith(`${base}/`)) return key;
  return null;
}
