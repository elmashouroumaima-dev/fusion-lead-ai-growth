import type { InvitationRow, MemberRow } from "@fusion-leap/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string, values?: Record<string, string>) => (values?.id ? `${key}:${values.id}` : key),
  getFormatter: async () => ({ dateTime: () => "DATE" }),
}));
vi.mock("./member-actions", () => ({
  MemberActions: ({ memberId, canRemove }: { memberId: string; canRemove: boolean }) => (
    <button type="button" data-testid="member-actions" data-member={memberId} data-remove={String(canRemove)} />
  ),
}));
vi.mock("./revoke-invitation-form", () => ({
  RevokeInvitationForm: ({ invitationId }: { invitationId: string }) => <button type="button" data-testid="revoke" data-invitation={invitationId} />,
}));

import { InvitationList } from "./invitation-list";
import { MemberList } from "./member-list";

const member = (over: Partial<MemberRow>): MemberRow =>
  ({
    id: "m1",
    user_id: "00000000-0000-0000-0000-0000000abc12",
    role: "sales_agent",
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  }) as MemberRow;

const invitation = (over: Partial<InvitationRow>): InvitationRow =>
  ({ id: "i1", email_normalized: "a@b.test", role: "sales_agent", expires_at: "2026-02-01T00:00:00Z", ...over }) as InvitationRow;

const count = (html: string, needle: string) => html.split(needle).length - 1;
const mdOnlyTable = (html: string) => html.includes('class="hidden lg:block"');

describe("liste des membres : cartes sous lg, tableau à partir de lg", () => {
  const props = { locale: "fr" as const, organizationId: "o1", currentUserId: "u-self", currentRole: "company_owner" as const };

  it("une carte par membre (ul lg:hidden) et le tableau reste pour les grands écrans", async () => {
    const html = renderToStaticMarkup(
      await MemberList({ ...props, members: [member({ id: "m1" }), member({ id: "m2", user_id: "00000000-0000-0000-0000-0000000abc13" })] }),
    );
    expect(html).toContain('<ul aria-labelledby="members-title" class="grid gap-4 lg:hidden">');
    expect(count(html, "<li ")).toBe(2);
    expect(mdOnlyTable(html)).toBe(true);
    expect(html).toContain("<table");
  });

  it("les actions existantes sont présentes dans chaque vue pour un membre gérable", async () => {
    const html = renderToStaticMarkup(await MemberList({ ...props, members: [member({ id: "m1" })] }));
    expect(count(html, 'data-testid="member-actions"')).toBe(2);
  });

  it("pas d'actions pour soi-même ; mention « vous » ; libellés i18n (aucun texte en dur)", async () => {
    const html = renderToStaticMarkup(await MemberList({ ...props, members: [member({ id: "m1", user_id: "u-self" })] }));
    expect(count(html, 'data-testid="member-actions"')).toBe(0);
    expect(html).toContain("list.you");
    expect(html).toContain("table.role");
    expect(html).toContain("table.status");
    expect(html).toContain("table.joined");
  });

  it("état vide : ni carte ni tableau", async () => {
    const html = renderToStaticMarkup(await MemberList({ ...props, members: [] }));
    expect(html).toContain("list.empty");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("<li ");
  });
});

describe("liste des invitations : cartes sous lg, tableau à partir de lg", () => {
  const props = { locale: "fr" as const, organizationId: "o1", currentRole: "company_owner" as const, now: new Date("2026-03-01T00:00:00Z") };

  it("une carte par invitation, e-mail en LTR, badge expirée, annulation disponible dans les deux vues", async () => {
    const html = renderToStaticMarkup(await InvitationList({ ...props, invitations: [invitation({ id: "i1" }), invitation({ id: "i2" })] }));
    expect(html).toContain('<ul aria-labelledby="pending-title" class="grid gap-4 lg:hidden">');
    expect(count(html, "<li ")).toBe(2);
    expect(mdOnlyTable(html)).toBe(true);
    expect(count(html, 'data-testid="revoke"')).toBe(4);
    expect(html).toContain('dir="ltr"');
    expect(html).toContain("invitations.expired");
  });

  it("un admin n'a pas l'annulation d'une invitation owner", async () => {
    const html = renderToStaticMarkup(
      await InvitationList({ ...props, currentRole: "company_admin", invitations: [invitation({ role: "company_owner" })] }),
    );
    expect(count(html, 'data-testid="revoke"')).toBe(0);
  });

  it("état vide", async () => {
    const html = renderToStaticMarkup(await InvitationList({ ...props, invitations: [] }));
    expect(html).toContain("invitations.empty");
    expect(html).not.toContain("<li ");
  });
});
