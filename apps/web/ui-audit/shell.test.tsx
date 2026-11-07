import { ROLES, can, type Role } from "@fusion-leap/permissions";
import type * as ReactTypes from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Coquille de l'application (ADR 015) : visibilité du lien « Membres » par rôle (layout serveur réel), côté de la barre
 * latérale selon la direction, sélecteur de thème, sélecteur de langue, menu du compte / déconnexion.
 */

// --------------------------------------------------------------------------------------------------
// Doubles
// --------------------------------------------------------------------------------------------------

let currentLocale = "fr";
let currentPathname = "/dashboard";
const setTheme = vi.fn();
let currentTheme: string | undefined;
const formActions: unknown[] = [];

vi.mock("next-intl", () => ({
  useLocale: () => currentLocale,
  useTranslations: (ns: string) => (key: string) => `${ns}:${key}`,
}));
vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: currentTheme, setTheme }),
  ThemeProvider: "next-themes-provider",
}));
vi.mock("../i18n/navigation", () => ({
  Link: "a",
  usePathname: () => currentPathname,
}));
const { signOutSentinel } = vi.hoisted(() => ({ signOutSentinel: vi.fn() }));
vi.mock("../lib/auth/actions", () => ({ signOutAction: signOutSentinel }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactTypes>();
  return {
    ...actual,
    default: actual,
    useActionState: (action: unknown, initial: unknown) => {
      formActions.push(action);
      return [initial, action, false];
    },
  };
});

const requireClaims = vi.fn();
const listMyMemberships = vi.fn();
const readActiveOrgCookie = vi.fn();
vi.mock("../i18n/require-locale", () => ({ requireLocale: async (p: Promise<{ locale: string }>) => (await p).locale }));
vi.mock("../lib/auth/require-claims", () => ({ requireClaims: (...a: unknown[]) => requireClaims(...a) }));
vi.mock("../lib/tenant/memberships", () => ({ listMyMemberships: (...a: unknown[]) => listMyMemberships(...a) }));
vi.mock("../lib/tenant/active-org-cookie", () => ({ readActiveOrgCookie: (...a: unknown[]) => readActiveOrgCookie(...a) }));
vi.mock("@/components/layout/app-shell", () => ({ AppShell: () => null }));

import AppLayout from "../app/[locale]/(app)/layout";
import { AppSidebar } from "../components/layout/app-sidebar";
import { LanguageSwitcher } from "../components/layout/language-switcher";
import { UserMenu } from "../components/layout/user-menu";
import { ThemeProvider } from "../components/theme/theme-provider";
import { ThemeToggle } from "../components/theme/theme-toggle";
import { DropdownMenuRadioGroup, DropdownMenuRadioItem } from "../components/ui/dropdown-menu";
import { Sidebar, SidebarProvider } from "../components/ui/sidebar";
import { getDirection } from "../i18n/direction";
import { LOCALE_NATIVE_NAMES } from "../i18n/locale-names";
import { routing } from "../i18n/routing";

type El = { type?: unknown; props?: { children?: unknown; [k: string]: unknown } };
function walk(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => walk(n, out));
  else if (node && typeof node === "object" && "props" in node) {
    out.push(node as El);
    walk((node as El).props?.children, out);
  }
  return out;
}

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const membership = (organizationId: string, role: Role, name = "Org") => ({
  organizationId,
  role,
  organization: { id: organizationId, name, slug: name.toLowerCase(), locale: "fr", timezone: "UTC", status: "active" as const },
});

beforeEach(() => {
  vi.clearAllMocks();
  formActions.length = 0;
  currentLocale = "fr";
  currentPathname = "/dashboard";
  currentTheme = undefined;
  requireClaims.mockResolvedValue({ email: "ada@example.test" });
  listMyMemberships.mockResolvedValue([membership(ORG_A, "company_owner")]);
  readActiveOrgCookie.mockResolvedValue(undefined);
});

const layoutProps = async (): Promise<{ showMembers: boolean; activeOrganizationName?: string; email: string | null }> => {
  const element = (await AppLayout({ children: null, params: Promise.resolve({ locale: "fr" }) })) as unknown as El;
  return element.props as unknown as { showMembers: boolean; activeOrganizationName?: string; email: string | null };
};

const renderSidebar = (showMembers: boolean, side?: "start" | "end"): string =>
  renderToStaticMarkup(
    <SidebarProvider>{side ? <Sidebar side={side} mobileTitle="t" mobileDescription="d" closeLabel="c" /> : <AppSidebar showMembers={showMembers} />}</SidebarProvider>,
  );

// --------------------------------------------------------------------------------------------------
// « Membres » : seulement owner / admin (table sur les cinq rôles)
// --------------------------------------------------------------------------------------------------

describe("barre latérale : « Membres » réservé aux rôles qui peuvent lister les membres", () => {
  const EXPECTED: Record<Role, boolean> = {
    company_owner: true,
    company_admin: true,
    marketing_manager: false,
    sales_agent: false,
    analyst: false,
  };

  it("la table couvre exactement les cinq rôles de la matrice", () => {
    expect([...ROLES].sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(ROLES).toHaveLength(5);
  });

  it.each(ROLES.map((role) => [role, EXPECTED[role]] as const))("rôle %s : lien Membres = %s (layout serveur puis rendu)", async (role, visible) => {
    listMyMemberships.mockResolvedValue([membership(ORG_A, role)]);
    const props = await layoutProps();
    expect(props.showMembers).toBe(visible);
    expect(props.showMembers).toBe(can(role, "list", "members"));

    const html = renderSidebar(props.showMembers);
    expect(html.includes('href="/members"'), html).toBe(visible);
    expect(html.includes("Shell:nav.members")).toBe(visible);
    // « Tableau de bord » est toujours présent
    expect(html).toContain('href="/dashboard"');
  });

  it("le rôle retenu est celui de l'organisation ACTIVE (cookie), pas celui de la première adhésion", async () => {
    listMyMemberships.mockResolvedValue([membership(ORG_A, "company_owner", "Alpha"), membership(ORG_B, "sales_agent", "Beta")]);
    readActiveOrgCookie.mockResolvedValue(ORG_B);
    const props = await layoutProps();
    expect(props.showMembers).toBe(false);
    expect(props.activeOrganizationName).toBe("Beta");

    readActiveOrgCookie.mockResolvedValue(ORG_A);
    expect((await layoutProps()).showMembers).toBe(true);
  });

  it("échec fermé : aucune organisation active résolvable -> pas de lien (plusieurs adhésions sans indice)", async () => {
    listMyMemberships.mockResolvedValue([membership(ORG_A, "company_owner", "Alpha"), membership(ORG_B, "company_admin", "Beta")]);
    expect((await layoutProps()).showMembers).toBe(false);
  });

  it("échec fermé : un cookie ne désignant aucune de MES adhésions ne donne pas le lien", async () => {
    readActiveOrgCookie.mockResolvedValue("33333333-3333-4333-8333-333333333333");
    expect((await layoutProps()).showMembers).toBe(false);
  });

  it("échec fermé : lecture des adhésions en erreur -> pas de lien, pas d'exception", async () => {
    listMyMemberships.mockRejectedValue(new Error("db down"));
    expect((await layoutProps()).showMembers).toBe(false);
  });

  it("échec fermé : organisation inactive (suspendue) -> pas de lien", async () => {
    const suspended = membership(ORG_A, "company_owner");
    listMyMemberships.mockResolvedValue([{ ...suspended, organization: { ...suspended.organization, status: "suspended" } }]);
    expect((await layoutProps()).showMembers).toBe(false);
  });

  it("l'adresse e-mail vient des claims vérifiés (jamais d'un paramètre client)", async () => {
    expect((await layoutProps()).email).toBe("ada@example.test");
    requireClaims.mockResolvedValue({ email: 42 });
    expect((await layoutProps()).email).toBeNull();
  });
});

// --------------------------------------------------------------------------------------------------
// Côté de la barre latérale
// --------------------------------------------------------------------------------------------------

describe("barre latérale : côté logique, à droite en arabe, à gauche en français et en anglais", () => {
  /** Côté physique obtenu par le navigateur : côté logique + direction du document. */
  const physicalSide = (logical: "start" | "end", dir: "ltr" | "rtl"): "left" | "right" =>
    (logical === "start") === (dir === "ltr") ? "left" : "right";

  it.each([
    ["ar", "rtl", "right"],
    ["fr", "ltr", "left"],
    ["en", "ltr", "left"],
  ] as const)("locale %s : dir=%s -> barre à %s", (locale, dir, side) => {
    expect(getDirection(locale)).toBe(dir);
    currentLocale = locale;
    // AppSidebar ne reçoit AUCUNE information de locale : le côté suit la direction du document.
    const html = renderSidebar(true);
    expect(html).toContain('data-side="start"');
    expect(physicalSide("start", getDirection(locale))).toBe(side);
  });

  it("le conteneur fixe est positionné avec des propriétés logiques (start-0 / end-0), jamais left/right", () => {
    const start = renderSidebar(true, "start");
    expect(start).toMatch(/data-slot="sidebar-container"[^>]*class="[^"]*\bstart-0\b/);
    expect(start).toMatch(/\bborder-e\b/);
    const end = renderSidebar(true, "end");
    expect(end).toMatch(/data-slot="sidebar-container"[^>]*class="[^"]*\bend-0\b/);
    expect(end).toMatch(/\bborder-s\b/);
    for (const html of [start, end]) {
      expect(html).not.toMatch(/\b(?:left|right)-0\b/);
      expect(html).not.toMatch(/\bborder-[lr]\b/);
    }
  });

  it("la contre-épreuve : le mapping physique est bien inversé par la direction", () => {
    expect(physicalSide("start", "rtl")).toBe("right");
    expect(physicalSide("end", "rtl")).toBe("left");
    expect(physicalSide("start", "ltr")).toBe("left");
    expect(physicalSide("end", "ltr")).toBe("right");
  });

  it("la barre latérale est repliable en icônes et expose une navigation étiquetée", () => {
    const html = renderSidebar(true);
    expect(html).toContain("<nav");
    expect(html).toContain('aria-label="Shell:nav.label"');
  });

  it("le lien actif porte aria-current=page", () => {
    currentPathname = "/members";
    const html = renderSidebar(true);
    expect(html).toMatch(/<a[^>]*href="\/members"[^>]*aria-current="page"|<a[^>]*aria-current="page"[^>]*href="\/members"/);
    expect(html).not.toMatch(/<a[^>]*href="\/dashboard"[^>]*aria-current="page"/);
  });
});

// --------------------------------------------------------------------------------------------------
// Thème
// --------------------------------------------------------------------------------------------------

describe("sélecteur de thème : clair / sombre / système", () => {
  it("propose exactement light, dark, system dans cet ordre", () => {
    const items = walk(ThemeToggle()).filter((e) => e.type === DropdownMenuRadioItem);
    expect(items.map((e) => e.props?.value)).toEqual(["light", "dark", "system"]);
  });

  it("la valeur sélectionnée est le thème courant, « system » par défaut", () => {
    const group = (): El => walk(ThemeToggle()).find((e) => e.type === DropdownMenuRadioGroup) as El;
    expect(group().props?.value).toBe("system");
    currentTheme = "dark";
    expect(group().props?.value).toBe("dark");
  });

  it("n'appelle setTheme que pour une valeur valide", () => {
    const group = walk(ThemeToggle()).find((e) => e.type === DropdownMenuRadioGroup) as El;
    const onChange = group.props?.onValueChange as (v: string) => void;
    for (const ok of ["light", "dark", "system"]) onChange(ok);
    expect(setTheme.mock.calls).toEqual([["light"], ["dark"], ["system"]]);
    setTheme.mockClear();
    for (const bad of ["", "Dark", "blue", "<script>"]) onChange(bad);
    expect(setTheme).not.toHaveBeenCalled();
  });

  it("le déclencheur (bouton icône) a un nom accessible traduit", () => {
    const trigger = walk(ThemeToggle()).find((e) => e.props?.["aria-label"] === "Shell.theme:label");
    expect(trigger).toBeDefined();
  });

  it("le fournisseur : classe, système par défaut, clé fl-theme, sans transition au changement", () => {
    const provider = ThemeProvider({ children: null }) as unknown as El;
    expect(provider.type).toBe("next-themes-provider");
    expect(provider.props).toMatchObject({
      attribute: "class",
      defaultTheme: "system",
      enableSystem: true,
      storageKey: "fl-theme",
      disableTransitionOnChange: true,
    });
  });
});

// --------------------------------------------------------------------------------------------------
// Langue
// --------------------------------------------------------------------------------------------------

describe("sélecteur de langue : exactement les deux autres locales", () => {
  const anchors = (): El[] => walk(LanguageSwitcher()).filter((e) => e.type === "a" || (e.props && "hrefLang" in e.props));

  it.each(routing.locales.map((l) => [l] as const))("depuis %s : les deux autres, avec lang et hrefLang", (locale) => {
    currentLocale = locale;
    const links = anchors();
    const expected = routing.locales.filter((l) => l !== locale);
    expect(expected).toHaveLength(2);
    expect(links.map((l) => l.props?.locale)).toEqual(expected);
    for (const link of links) {
      const target = link.props?.locale as keyof typeof LOCALE_NATIVE_NAMES;
      expect(link.props?.lang).toBe(target);
      expect(link.props?.hrefLang).toBe(target);
      expect(link.props?.children).toBe(LOCALE_NATIVE_NAMES[target]);
      expect(link.props?.href).toBe("/dashboard");
    }
    expect(links.map((l) => l.props?.locale)).not.toContain(locale);
  });

  it("le déclencheur du menu a un nom accessible et aucun repère <nav> supplémentaire n'est créé", () => {
    const tree = walk(LanguageSwitcher());
    expect(tree.some((e) => e.type === "nav")).toBe(false);
    expect(tree.some((e) => e.props?.["aria-label"] === "LanguageSwitcher:label")).toBe(true);
  });
});

// --------------------------------------------------------------------------------------------------
// Déconnexion
// --------------------------------------------------------------------------------------------------

describe("menu du compte : la déconnexion poste l'action serveur existante", () => {
  it("le formulaire est branché sur signOutAction et porte la locale en champ caché", () => {
    currentLocale = "ar";
    const html = renderToStaticMarkup(<UserMenu email="ada@example.test" />);
    expect(formActions).toEqual([signOutSentinel]);
    expect(html).toMatch(/<form[^>]*>\s*<input[^>]*type="hidden"[^>]*name="locale"[^>]*value="ar"/);
    // aucun champ supplémentaire (ni e-mail ni jeton) dans le formulaire de déconnexion
    const form = /<form[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";
    expect([...form.matchAll(/<input[^>]*name="([^"]+)"/g)].map((m) => m[1])).toEqual(["locale"]);
  });

  it("le déclencheur a un nom accessible, l'avatar est décoratif et affiche l'initiale", () => {
    const html = renderToStaticMarkup(<UserMenu email="ada@example.test" />);
    expect(html).toContain('aria-label="Shell.profile:menu"');
    expect(html).toMatch(/>A</);
  });

  it("sans e-mail connu : initiale neutre, pas d'exception", () => {
    const html = renderToStaticMarkup(<UserMenu email={null} />);
    expect(html).toMatch(/>\?</);
  });

  it("le formulaire de déconnexion n'est pas visible (hidden) et n'embarque pas l'e-mail", () => {
    const html = renderToStaticMarkup(<UserMenu email="secret@example.test" />);
    const form = /<form[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";
    expect(form).toContain('class="hidden"');
    expect(form).not.toContain("secret@example.test");
  });
});
