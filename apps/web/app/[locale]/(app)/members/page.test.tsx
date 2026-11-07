import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";

class RedirectSignal extends Error {
  constructor(public readonly url: string) {
    super("NEXT_REDIRECT");
  }
}
const requireClaims = vi.fn();
const requireTenantContext = vi.fn();
const listOrganizationMembers = vi.fn();
const listPendingInvitations = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => `T:${key}`,
  setRequestLocale: () => undefined,
}));
vi.mock("../../../../i18n/require-locale", () => ({ requireLocale: async (p: Promise<{ locale: string }>) => (await p).locale }));
vi.mock("../../../../lib/auth/require-claims", () => ({ requireClaims: (...a: unknown[]) => requireClaims(...a) }));
vi.mock("../../../../lib/tenant/context", () => ({ requireTenantContext: (...a: unknown[]) => requireTenantContext(...a) }));
vi.mock("../../../../lib/members/queries", () => ({
  listOrganizationMembers: (...a: unknown[]) => listOrganizationMembers(...a),
  listPendingInvitations: (...a: unknown[]) => listPendingInvitations(...a),
}));
vi.mock("../../../../components/members/invitation-list", () => ({ InvitationList: () => null }));
vi.mock("../../../../components/members/invite-form", () => ({ InviteForm: () => null }));
vi.mock("../../../../components/members/member-list", () => ({ MemberList: () => null }));

import { InvitationList } from "../../../../components/members/invitation-list";
import { InviteForm } from "../../../../components/members/invite-form";
import { MemberList } from "../../../../components/members/member-list";
import MembersPage from "./page";

type El = { type?: unknown; props?: { children?: unknown; [k: string]: unknown } };
function walk(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => walk(n, out));
  else if (node && typeof node === "object" && "props" in node) {
    out.push(node as El);
    walk((node as El).props?.children, out);
  }
  return out;
}
const ctxFor = (role: string) => ({
  userId: ME,
  organizationId: ORG,
  role,
  organization: { id: ORG, name: "X", slug: "x", locale: "ar", timezone: "UTC" },
});
const render = (locale = "en") => MembersPage({ params: Promise.resolve({ locale }) });

beforeEach(() => {
  vi.clearAllMocks();
  listOrganizationMembers.mockResolvedValue([]);
  listPendingInvitations.mockResolvedValue([]);
});

describe("page Membres : contrôle d'accès", () => {
  it.each(["marketing_manager", "sales_agent", "analyst"])("%s : redirigé vers le tableau de bord, aucune lecture de membres", async (role) => {
    requireTenantContext.mockResolvedValue(ctxFor(role));
    await expect(render("en")).rejects.toMatchObject({ url: "/en/dashboard" });
    expect(listOrganizationMembers).not.toHaveBeenCalled();
    expect(listPendingInvitations).not.toHaveBeenCalled();
  });

  it("redirection dans la locale demandée (ar)", async () => {
    requireTenantContext.mockResolvedValue(ctxFor("analyst"));
    await expect(render("ar")).rejects.toMatchObject({ url: "/ar/dashboard" });
  });

  it("rôle inconnu ou corrompu : fail closed (redirigé)", async () => {
    requireTenantContext.mockResolvedValue(ctxFor("superuser"));
    await expect(render("en")).rejects.toMatchObject({ url: "/en/dashboard" });
    expect(listOrganizationMembers).not.toHaveBeenCalled();
  });

  it("locale invalide : refusée avant toute lecture", async () => {
    requireTenantContext.mockResolvedValue(ctxFor("company_owner"));
    await expect(render("es")).rejects.toThrow();
    await expect(render("FR")).rejects.toThrow();
    expect(listOrganizationMembers).not.toHaveBeenCalled();
  });

  it("session et contexte tenant requis (leurs redirections se propagent)", async () => {
    requireClaims.mockRejectedValueOnce(new RedirectSignal("/en/login"));
    await expect(render("en")).rejects.toMatchObject({ url: "/en/login" });
    requireTenantContext.mockRejectedValueOnce(new RedirectSignal("/en/onboarding"));
    await expect(render("en")).rejects.toMatchObject({ url: "/en/onboarding" });
  });
});

describe("page Membres : rendu pour owner / admin", () => {
  it("company_owner : formulaire d'invitation avec les 5 rôles, listes, organisation du contexte", async () => {
    requireTenantContext.mockResolvedValue(ctxFor("company_owner"));
    const els = walk(await render("en"));
    const invite = els.find((e) => e.type === InviteForm);
    expect(invite?.props?.organizationId).toBe(ORG);
    expect(invite?.props?.roleOptions).toEqual(["company_owner", "company_admin", "marketing_manager", "sales_agent", "analyst"]);
    expect(els.find((e) => e.type === MemberList)?.props).toMatchObject({ organizationId: ORG, currentUserId: ME, currentRole: "company_owner" });
    expect(els.find((e) => e.type === InvitationList)?.props).toMatchObject({ organizationId: ORG, currentRole: "company_owner" });
  });

  it("company_admin : le rôle company_owner n'est jamais proposé", async () => {
    requireTenantContext.mockResolvedValue(ctxFor("company_admin"));
    const invite = walk(await render("en")).find((e) => e.type === InviteForm);
    expect(invite?.props?.roleOptions).toEqual(["company_admin", "marketing_manager", "sales_agent", "analyst"]);
  });

  it("lectures faites avec le contexte vérifié", async () => {
    const ctx = ctxFor("company_owner");
    requireTenantContext.mockResolvedValue(ctx);
    await render("en");
    expect(listOrganizationMembers).toHaveBeenCalledWith(ctx);
    expect(listPendingInvitations).toHaveBeenCalledWith(ctx);
  });

  it("échec de lecture : message en role=alert, ni formulaire ni liste, aucune fuite du message d'erreur", async () => {
    requireTenantContext.mockResolvedValue(ctxFor("company_owner"));
    listOrganizationMembers.mockRejectedValue(new Error("select * from secret"));
    const els = walk(await render("en"));
    expect(els.some((e) => e.type === InviteForm || e.type === MemberList || e.type === InvitationList)).toBe(false);
    expect(els.find((e) => e.props?.role === "alert")?.props?.children).toBe("T:errors.loadFailed");
  });
});
