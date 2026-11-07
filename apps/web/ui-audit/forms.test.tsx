import type * as ReactTypes from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Les formulaires gardent leur comportement après la refonte (ADR 015) : noms de champs, champs cachés (idempotence,
 * locale, jeton, organisation), action serveur d'origine, libellés associés, erreurs reliées par aria-describedby,
 * régions role=alert / role=status.
 *
 * Rendu côté serveur (react-dom/server) : aucune bibliothèque de test DOM n'est installée dans le dépôt. Les fenêtres
 * Radix (portails) ne se montent pas côté serveur : `Dialog` est remplacé par un conteneur transparent pour que les
 * formulaires qu'elles contiennent soient inspectables.
 */

let currentLocale = "fr";
let stateOverride: unknown;
const captured: unknown[] = [];

const actions = vi.hoisted(() => ({
  createOrganizationAction: vi.fn(),
  switchOrganizationAction: vi.fn(),
  inviteMemberAction: vi.fn(),
  changeMemberRoleAction: vi.fn(),
  removeMemberAction: vi.fn(),
  transferOwnershipAction: vi.fn(),
  revokeInvitationAction: vi.fn(),
  acceptInvitationAction: vi.fn(),
  authAction: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useLocale: () => currentLocale,
  useTranslations: (ns: string) => (key: string, values?: Record<string, unknown>) =>
    `${ns}:${key}${values ? `(${Object.entries(values).map(([k, v]) => `${k}=${String(v)}`).join(",")})` : ""}`,
}));
vi.mock("../lib/tenant/actions", () => ({
  createOrganizationAction: actions.createOrganizationAction,
  switchOrganizationAction: actions.switchOrganizationAction,
}));
vi.mock("../lib/members/actions", () => ({
  inviteMemberAction: actions.inviteMemberAction,
  changeMemberRoleAction: actions.changeMemberRoleAction,
  removeMemberAction: actions.removeMemberAction,
  transferOwnershipAction: actions.transferOwnershipAction,
  revokeInvitationAction: actions.revokeInvitationAction,
  acceptInvitationAction: actions.acceptInvitationAction,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactTypes>();
  return {
    ...actual,
    default: actual,
    useActionState: (action: unknown, initial: unknown) => {
      captured.push(action);
      return [stateOverride ?? initial, action, false];
    },
  };
});
vi.mock("../components/ui/dialog", () => {
  const passthrough = (name: string) => ({ children }: { children?: unknown }) => ({
    $$typeof: Symbol.for("react.transitional.element"),
    type: "div",
    key: null,
    ref: null,
    props: { "data-mock": name, children },
  });
  return {
    Dialog: passthrough("dialog"),
    DialogTrigger: passthrough("dialog-trigger"),
    DialogContent: passthrough("dialog-content"),
    DialogHeader: passthrough("dialog-header"),
    DialogFooter: passthrough("dialog-footer"),
    DialogTitle: passthrough("dialog-title"),
    DialogDescription: passthrough("dialog-description"),
  };
});

import { AuthForm, type AuthField } from "../components/auth/auth-form";
import { AcceptInvitationForm } from "../components/members/accept-invitation-form";
import { InviteForm } from "../components/members/invite-form";
import { MemberActions } from "../components/members/member-actions";
import { RevokeInvitationForm } from "../components/members/revoke-invitation-form";
import { CreateOrganizationForm } from "../components/org/create-organization-form";
import { OrganizationList } from "../components/org/organization-list";
import { OrganizationSwitcher } from "../components/org/organization-switcher";
import { INITIAL_ERROR_CODES } from "../components/auth/initial-error";

// --------------------------------------------------------------------------------------------------
// Analyse du balisage statique
// --------------------------------------------------------------------------------------------------

type Tag = { name: string; attrs: Record<string, string | true>; raw: string };

function tags(html: string, name: string): Tag[] {
  const out: Tag[] = [];
  for (const m of html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, "g"))) {
    const attrs: Record<string, string | true> = {};
    for (const a of (m[1] as string).matchAll(/([\w:.-]+)(?:="([^"]*)")?/g)) attrs[(a[1] as string).toLowerCase()] = a[2] ?? true;
    out.push({ name, attrs, raw: m[0] });
  }
  return out;
}

const hiddenFields = (html: string): Record<string, string> =>
  Object.fromEntries(
    tags(html, "input")
      .filter((i) => i.attrs.type === "hidden")
      .map((i) => [String(i.attrs.name), String(i.attrs.value ?? "")]),
  );

const nameOf = (t: Tag): string | undefined => (typeof t.attrs.name === "string" ? t.attrs.name : undefined);
const idsOf = (html: string): string[] => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] as string);
const labelFor = (html: string): Map<string, string> => {
  const map = new Map<string, string>();
  for (const m of html.matchAll(/<label\b[^>]*\sfor="([^"]+)"[^>]*>([\s\S]*?)<\/label>/g)) map.set(m[1] as string, (m[2] as string).replace(/<[^>]+>/g, ""));
  return map;
};
const describedBy = (t: Tag): string[] => String(t.attrs["aria-describedby"] ?? "").split(/\s+/).filter(Boolean);
const textOfId = (html: string, id: string): string | null => {
  const m = new RegExp(`<(\\w+)[^>]*\\sid="${id.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&")}"[^>]*>([\\s\\S]*?)</\\1>`).exec(html);
  return m ? (m[2] as string).replace(/<[^>]+>/g, "") : null;
};

beforeEach(() => {
  vi.clearAllMocks();
  currentLocale = "fr";
  stateOverride = undefined;
  captured.length = 0;
});

// --------------------------------------------------------------------------------------------------
// AuthForm
// --------------------------------------------------------------------------------------------------

const LOGIN_FIELDS: AuthField[] = [
  { name: "email", label: "email", type: "email", autoComplete: "email" },
  { name: "password", label: "password", type: "password", autoComplete: "current-password" },
];

describe("AuthForm : connexion", () => {
  const render = (extra: Partial<Parameters<typeof AuthForm>[0]> = {}) =>
    renderToStaticMarkup(<AuthForm action={actions.authAction} fields={LOGIN_FIELDS} submitLabel="Entrer" next="/members" {...extra} />);

  it("est branché sur l'action reçue et poste locale + next en champs cachés", () => {
    currentLocale = "ar";
    const html = render();
    expect(captured).toEqual([actions.authAction]);
    expect(hiddenFields(html)).toEqual({ locale: "ar", next: "/members" });
  });

  it("n'envoie pas de champ next quand il est absent", () => {
    expect(hiddenFields(render({ next: undefined }))).toEqual({ locale: "fr" });
  });

  it("garde les noms, types, attributs de saisie et le caractère obligatoire des champs", () => {
    const html = render();
    const visible = tags(html, "input").filter((i) => i.attrs.type !== "hidden");
    expect(visible.map(nameOf)).toEqual(["email", "password"]);
    const [email, password] = visible as [Tag, Tag];
    expect(email.attrs).toMatchObject({ type: "email", autocomplete: "email", inputmode: "email", dir: "ltr" });
    expect(email.attrs.required).toBeDefined();
    expect(password.attrs).toMatchObject({ type: "password", autocomplete: "current-password", dir: "ltr" });
    expect(password.attrs.required).toBeDefined();
  });

  it("associe un libellé à chaque champ (for == id)", () => {
    const html = render();
    const labels = labelFor(html);
    for (const input of tags(html, "input").filter((i) => i.attrs.type !== "hidden")) {
      expect(typeof input.attrs.id, nameOf(input)).toBe("string");
      expect(labels.get(String(input.attrs.id)), nameOf(input)).toMatch(/^Auth\.fields|^Auth:fields\./);
    }
    // les identifiants sont uniques
    expect(new Set(idsOf(html)).size).toBe(idsOf(html).length);
  });

  it("le bouton « afficher le mot de passe » a un nom accessible, un état et pointe sur le champ", () => {
    const html = render();
    const toggle = tags(html, "button").find((b) => b.attrs["aria-pressed"] !== undefined) as Tag;
    expect(toggle.attrs).toMatchObject({ type: "button", "aria-label": "Auth.fields:showPassword", "aria-pressed": "false" });
    const passwordInput = tags(html, "input").find((i) => nameOf(i) === "password") as Tag;
    expect(toggle.attrs["aria-controls"]).toBe(passwordInput.attrs.id);
  });

  it("le bouton d'envoi est de type submit, actif au repos, et le formulaire n'est pas occupé", () => {
    const html = render();
    const submit = tags(html, "button").find((b) => b.attrs.type === "submit") as Tag;
    expect(submit.attrs.disabled).toBeUndefined();
    expect(html).toContain("Entrer");
    expect(html).toMatch(/<form[^>]*aria-busy="false"/);
  });

  it("les régions role=alert et role=status sont toujours montées (vides au repos)", () => {
    const html = render();
    expect(html).toMatch(/<div role="alert"[^>]*class="sr-only"[^>]*><\/div>/);
    expect(html).toMatch(/<div role="status"[^>]*class="sr-only"[^>]*><\/div>/);
  });

  it("une erreur initiale (lien invalide) s'affiche dans la région role=alert", () => {
    const code = INITIAL_ERROR_CODES[0];
    const html = render({ initialErrorCode: code });
    const alert = /<div role="alert"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
    expect(alert).toContain(`Auth:errors.${code}`);
    expect(html).not.toMatch(/<div role="alert"[^>]*class="sr-only"/);
  });

  it("une erreur d'action (code connu) est annoncée en role=alert, avec son code traduit", () => {
    stateOverride = { status: "error", code: "invalid_credentials" };
    const html = render();
    expect(/<div role="alert"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1]).toContain("Auth:errors.invalid_credentials");
  });

  it("une erreur sans code retombe sur « generic »", () => {
    stateOverride = { status: "error" };
    expect(render()).toContain("Auth:errors.generic");
  });

  it("une erreur de champ marque le champ invalide et le relie à son message par aria-describedby", () => {
    stateOverride = { status: "error", code: "invalid_input", fieldErrors: { email: ["invalid"] } };
    const html = render();
    const email = tags(html, "input").find((i) => nameOf(i) === "email") as Tag;
    const password = tags(html, "input").find((i) => nameOf(i) === "password") as Tag;
    expect(email.attrs["aria-invalid"]).toBe("true");
    expect(password.attrs["aria-invalid"]).toBeUndefined();
    const ids = describedBy(email);
    expect(ids).toHaveLength(1);
    expect(idsOf(html)).toContain(ids[0]);
    expect(textOfId(html, ids[0] as string)).toBe("Auth:errors.invalid_input");
  });

  it("l'indice du mot de passe (création/réinitialisation) est relié au champ", () => {
    const html = renderToStaticMarkup(
      <AuthForm
        action={actions.authAction}
        submitLabel="Créer"
        fields={[{ name: "password", label: "newPassword", type: "password", autoComplete: "new-password", showPasswordHint: true }]}
      />,
    );
    const input = tags(html, "input").find((i) => nameOf(i) === "password") as Tag;
    expect(input.attrs.autocomplete).toBe("new-password");
    const [hintId] = describedBy(input);
    expect(textOfId(html, hintId as string)).toBe("Auth:hints.passwordMin");
  });

  it("un succès est annoncé en role=status avec le message fourni", () => {
    stateOverride = { status: "success" };
    const html = render({ successMessage: "Courriel envoyé" });
    expect(/<div role="status"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1]).toContain("Courriel envoyé");
    expect(html).not.toMatch(/<div role="status"[^>]*class="sr-only"/);
  });

  it("l'action de mot de passe oublié s'insère sur la ligne du libellé du mot de passe seulement", () => {
    const html = render({ passwordAction: <span>oublié</span> });
    expect(html.match(/oublié/g)).toHaveLength(1);
    expect(html.indexOf("oublié")).toBeGreaterThan(html.indexOf('for="'));
    expect(html.indexOf("oublié")).toBeLessThan(html.indexOf('name="password"'));
  });
});

// --------------------------------------------------------------------------------------------------
// Organisation
// --------------------------------------------------------------------------------------------------

describe("CreateOrganizationForm", () => {
  const render = () => renderToStaticMarkup(<CreateOrganizationForm creationKey="key-123" timeZones={["UTC", "Africa/Casablanca", "Europe/Paris"]} />);

  it("est branché sur createOrganizationAction et garde uiLocale + creation_key en champs cachés", () => {
    currentLocale = "ar";
    const html = render();
    expect(captured).toEqual([actions.createOrganizationAction]);
    expect(hiddenFields(html)).toMatchObject({ uiLocale: "ar", creation_key: "key-123" });
  });

  it("garde les champs name, timezone et locale (les sélecteurs Radix postent par leur champ natif)", () => {
    const html = render();
    const nameInput = tags(html, "input").find((i) => nameOf(i) === "name") as Tag;
    expect(nameInput.attrs).toMatchObject({ type: "text", autocomplete: "organization", maxlength: "120" });
    expect(nameInput.attrs.required).toBeDefined();
    const selectNames = tags(html, "select").map(nameOf);
    expect(selectNames).toEqual(expect.arrayContaining(["timezone", "locale"]));
  });

  it("associe un libellé à chaque contrôle (champ texte et déclencheurs de sélecteur)", () => {
    const html = render();
    const labels = labelFor(html);
    const nameInput = tags(html, "input").find((i) => nameOf(i) === "name") as Tag;
    expect(labels.has(String(nameInput.attrs.id))).toBe(true);
    const triggers = tags(html, "button").filter((b) => b.attrs.role === "combobox");
    expect(triggers).toHaveLength(2);
    for (const trigger of triggers) expect(labels.has(String(trigger.attrs.id)), String(trigger.attrs.id)).toBe(true);
  });

  it("la région d'erreur role=alert est montée au repos et affiche le code d'erreur traduit", () => {
    expect(render()).toMatch(/<div role="alert"[^>]*class="sr-only"/);
    stateOverride = { status: "error", code: "rate_limited" };
    expect(/<div role="alert"[^>]*>([\s\S]*?)<\/div>/.exec(render())?.[1]).toContain("Org:errors.rate_limited");
  });

  it("une erreur de champ relie le champ nom à son message", () => {
    stateOverride = { status: "error", code: "invalid_input", fieldErrors: { name: ["required"] } };
    const html = render();
    const nameInput = tags(html, "input").find((i) => nameOf(i) === "name") as Tag;
    expect(nameInput.attrs["aria-invalid"]).toBe("true");
    const [errId] = describedBy(nameInput);
    expect(textOfId(html, errId as string)).toBe("Org:errors.invalid_input");
  });

  it("le fuseau horaire est invalide-marqué et décrit par son message en cas d'erreur de champ", () => {
    stateOverride = { status: "error", code: "invalid_input", fieldErrors: { timezone: ["bad"] } };
    const html = render();
    const trigger = tags(html, "button").find((b) => b.attrs.role === "combobox" && b.attrs["aria-invalid"] === "true") as Tag;
    expect(trigger).toBeDefined();
    expect(textOfId(html, describedBy(trigger)[0] as string)).toBe("Org:errors.invalid_input");
  });
});

describe("OrganizationSwitcher", () => {
  const options = [
    { id: "11111111-1111-4111-8111-111111111111", name: "Alpha" },
    { id: "22222222-2222-4222-8222-222222222222", name: "Beta" },
  ];

  it("poste organization_id (sélecteur) + uiLocale vers switchOrganizationAction, avec bouton d'envoi", () => {
    currentLocale = "en";
    const html = renderToStaticMarkup(<OrganizationSwitcher options={options} selectedId={options[1]?.id} />);
    expect(captured).toEqual([actions.switchOrganizationAction]);
    expect(hiddenFields(html)).toEqual({ uiLocale: "en" });
    expect(tags(html, "select").map(nameOf)).toEqual(["organization_id"]);
    expect(tags(html, "button").some((b) => b.attrs.type === "submit")).toBe(true);
  });

  it("le sélecteur a un libellé associé (masqué visuellement) et une région de statut montée", () => {
    const html = renderToStaticMarkup(<OrganizationSwitcher options={options} />);
    const trigger = tags(html, "button").find((b) => b.attrs.role === "combobox") as Tag;
    expect(labelFor(html).get(String(trigger.attrs.id))).toBe("Org:switcher.label");
    expect(html).toMatch(/<span aria-live="polite" role="status"[^>]*class="sr-only"/);
  });

  it("une erreur est annoncée et reliée au sélecteur", () => {
    stateOverride = { status: "error", code: "forbidden" };
    const html = renderToStaticMarkup(<OrganizationSwitcher options={options} />);
    const trigger = tags(html, "button").find((b) => b.attrs.role === "combobox") as Tag;
    expect(trigger.attrs["aria-invalid"]).toBe("true");
    expect(textOfId(html, describedBy(trigger)[0] as string)).toBe("Org:errors.forbidden");
  });
});

describe("OrganizationList", () => {
  const items = [
    { id: "11111111-1111-4111-8111-111111111111", name: "Alpha", role: "company_owner", status: "active" },
    { id: "22222222-2222-4222-8222-222222222222", name: "Beta", role: "analyst", status: "suspended" },
  ] as const;

  it("chaque ligne est un formulaire qui poste organization_id + uiLocale, avec nom accessible", () => {
    currentLocale = "ar";
    const html = renderToStaticMarkup(<OrganizationList items={items} currentId={items[0].id} />);
    expect(captured).toEqual([actions.switchOrganizationAction]);
    expect(tags(html, "form")).toHaveLength(2);
    const orgIds = tags(html, "input").filter((i) => nameOf(i) === "organization_id").map((i) => i.attrs.value);
    expect(orgIds).toEqual(items.map((i) => i.id));
    expect(tags(html, "input").filter((i) => nameOf(i) === "uiLocale").every((i) => i.attrs.value === "ar")).toBe(true);
    const buttons = tags(html, "button");
    expect(buttons.map((b) => b.attrs["aria-label"])).toEqual(["Org:select.openNamed(name=Alpha)", "Org:select.openNamed(name=Beta)"]);
  });

  it("une organisation inactive ne peut pas être ouverte ; l'organisation courante est signalée", () => {
    const html = renderToStaticMarkup(<OrganizationList items={items} currentId={items[0].id} />);
    const [first, second] = tags(html, "button") as [Tag, Tag];
    expect(first.attrs.disabled).toBeUndefined();
    expect(second.attrs.disabled).toBeDefined();
    expect(html).toContain("Org:select.current");
    expect(html).toContain("Org:select.inactive");
  });

  it("la liste est étiquetée et la région role=alert est montée", () => {
    const html = renderToStaticMarkup(<OrganizationList items={items} />);
    expect(tags(html, "ul")[0]?.attrs["aria-label"]).toBe("Org:select.listLabel");
    expect(html).toMatch(/<div role="alert"[^>]*class="sr-only"/);
  });
});

// --------------------------------------------------------------------------------------------------
// Membres / invitations
// --------------------------------------------------------------------------------------------------

const ORG = "11111111-1111-4111-8111-111111111111";
const KEY = "33333333-3333-4333-8333-333333333333";

describe("InviteForm", () => {
  const render = () => renderToStaticMarkup(<InviteForm organizationId={ORG} idempotencyKey={KEY} roleOptions={["company_admin", "sales_agent", "analyst"]} />);

  it("garde les champs cachés uiLocale, organization_id et idempotency_key", () => {
    currentLocale = "ar";
    expect(hiddenFields(render())).toEqual({ uiLocale: "ar", organization_id: ORG, idempotency_key: KEY });
  });

  it("garde le champ e-mail (nom, type, obligatoire, longueur max) et le sélecteur de rôle nommé role", () => {
    const html = render();
    const email = tags(html, "input").find((i) => nameOf(i) === "email") as Tag;
    expect(email.attrs).toMatchObject({ type: "email", maxlength: "254", dir: "ltr", autocomplete: "off" });
    expect(email.attrs.required).toBeDefined();
    expect(tags(html, "select").map(nameOf)).toEqual(["role"]);
  });

  it("associe les libellés à l'e-mail et au rôle ; l'indice d'adresse est relié à l'e-mail", () => {
    const html = render();
    const labels = labelFor(html);
    const email = tags(html, "input").find((i) => nameOf(i) === "email") as Tag;
    expect(labels.get(String(email.attrs.id))).toBe("Members:fields.email");
    const role = tags(html, "button").find((b) => b.attrs.role === "combobox") as Tag;
    expect(labels.get(String(role.attrs.id))).toBe("Members:fields.role");
    expect(textOfId(html, describedBy(email)[0] as string)).toBe("Members:invite.hints.email");
  });

  it("une erreur de champ e-mail est reliée en plus de l'indice ; le rôle invalide est marqué", () => {
    stateOverride = { status: "error", code: "invalid_input", fieldErrors: { email: ["x"], role: ["y"] } };
    const html = render();
    const email = tags(html, "input").find((i) => nameOf(i) === "email") as Tag;
    expect(email.attrs["aria-invalid"]).toBe("true");
    const ids = describedBy(email);
    expect(ids).toHaveLength(2);
    expect(textOfId(html, ids[1] as string)).toBe("Members:errors.invalid_input");
    const role = tags(html, "button").find((b) => b.attrs.role === "combobox") as Tag;
    expect(role.attrs["aria-invalid"]).toBe("true");
    expect(textOfId(html, describedBy(role)[0] as string)).toBe("Members:errors.invalid_input");
  });

  it("une erreur générale (sans champ) s'affiche dans la région role=alert", () => {
    stateOverride = { status: "error", code: "forbidden" };
    const html = render();
    expect(/<div role="alert"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1]).toContain("Members:errors.forbidden");
  });

  it("l'action enveloppée délègue bien à inviteMemberAction avec les mêmes arguments", async () => {
    render();
    const wrapped = captured[0] as (prev: unknown, data: FormData) => Promise<unknown>;
    const result = { status: "error", code: "forbidden" };
    actions.inviteMemberAction.mockResolvedValue(result);
    const data = new FormData();
    data.set("email", "x@example.test");
    const prev = { status: "idle" };
    await expect(wrapped(prev, data)).resolves.toBe(result);
    expect(actions.inviteMemberAction).toHaveBeenCalledWith(prev, data);
  });

  it("le lien d'invitation (affiché une fois) est un champ lecture seule étiqueté, dans un groupe", () => {
    stateOverride = { status: "success", invitePath: "/fr/invite/abc" };
    const html = render();
    const link = tags(html, "input").find((i) => i.attrs.readonly !== undefined) as Tag;
    expect(link.attrs.dir).toBe("ltr");
    expect(labelFor(html).get(String(link.attrs.id))).toBe("Members:inviteLink.label");
    expect(textOfId(html, describedBy(link)[0] as string)).toContain("Members:inviteLink.note");
    expect(html).toContain('role="group"');
  });
});

describe("MemberActions", () => {
  const render = () =>
    renderToStaticMarkup(
      <MemberActions
        organizationId={ORG}
        memberId="44444444-4444-4444-8444-444444444444"
        shortId="abcd1234"
        role="analyst"
        roleOptions={["company_admin", "sales_agent", "analyst"]}
        canChangeRole
        canRemove
        canTransfer
      />,
    );

  it("chaque formulaire de confirmation garde uiLocale, organization_id et member_id", () => {
    currentLocale = "ar";
    const html = render();
    const forms = html.split("<form").slice(1);
    expect(forms).toHaveLength(3);
    for (const form of forms) {
      expect(hiddenFields(form)).toMatchObject({ uiLocale: "ar", organization_id: ORG, member_id: "44444444-4444-4444-8444-444444444444" });
    }
  });

  it("le transfert de propriété garde son champ idempotency_key (rempli à l'ouverture), pas les autres formulaires", () => {
    const forms = render().split("<form").slice(1);
    const withKey = forms.filter((f) => "idempotency_key" in hiddenFields(f));
    expect(withKey).toHaveLength(1);
    expect(Object.keys(hiddenFields(withKey[0] as string)).sort()).toEqual(["idempotency_key", "member_id", "organization_id", "uiLocale"]);
  });

  it("le formulaire de rôle garde le sélecteur role ; le déclencheur du menu a un nom accessible", () => {
    const html = render();
    expect(tags(html, "select").map(nameOf)).toEqual(["role"]);
    const menu = tags(html, "button").find((b) => String(b.attrs["aria-label"] ?? "").startsWith("Members:actions.menu")) as Tag;
    expect(menu.attrs["aria-haspopup"]).toBe("menu");
    const role = tags(html, "button").find((b) => b.attrs.role === "combobox") as Tag;
    expect(labelFor(html).has(String(role.attrs.id))).toBe(true);
  });

  it("les trois actions enveloppées délèguent aux actions serveur d'origine", async () => {
    render();
    const [roleWrapped, removeWrapped, transferWrapped] = captured as Array<(prev: unknown, data: FormData) => Promise<unknown>>;
    const data = new FormData();
    const prev = { status: "idle" };
    for (const [wrapped, action] of [
      [roleWrapped, actions.changeMemberRoleAction],
      [removeWrapped, actions.removeMemberAction],
      [transferWrapped, actions.transferOwnershipAction],
    ] as const) {
      const result = { status: "error", code: "forbidden" };
      action.mockResolvedValue(result);
      await expect((wrapped as (p: unknown, d: FormData) => Promise<unknown>)(prev, data)).resolves.toBe(result);
      expect(action).toHaveBeenCalledWith(prev, data);
    }
  });

  it("les régions role=status de retour d'action sont montées", () => {
    expect(render().match(/role="status"/g)).toHaveLength(3);
  });
});

describe("RevokeInvitationForm", () => {
  it("poste uiLocale, organization_id et invitation_id ; bouton nommé avec l'adresse", () => {
    currentLocale = "en";
    const html = renderToStaticMarkup(<RevokeInvitationForm organizationId={ORG} invitationId={KEY} subject="x@example.test" />);
    expect(hiddenFields(html)).toEqual({ uiLocale: "en", organization_id: ORG, invitation_id: KEY });
    const button = tags(html, "button")[0] as Tag;
    expect(button.attrs).toMatchObject({ type: "submit", "aria-label": "Members:invitations.revokeLabel(email=x@example.test)" });
  });

  it("l'action enveloppée délègue à revokeInvitationAction", async () => {
    renderToStaticMarkup(<RevokeInvitationForm organizationId={ORG} invitationId={KEY} subject="x@example.test" />);
    const wrapped = captured[0] as (prev: unknown, data: FormData) => Promise<unknown>;
    const result = { status: "error", code: "forbidden" };
    actions.revokeInvitationAction.mockResolvedValue(result);
    const data = new FormData();
    await expect(wrapped({ status: "idle" }, data)).resolves.toBe(result);
    expect(actions.revokeInvitationAction).toHaveBeenCalledWith({ status: "idle" }, data);
  });
});

describe("AcceptInvitationForm", () => {
  it("poste le jeton et uiLocale vers acceptInvitationAction", () => {
    currentLocale = "ar";
    const html = renderToStaticMarkup(<AcceptInvitationForm token="tok_abc" />);
    expect(captured).toEqual([actions.acceptInvitationAction]);
    expect(hiddenFields(html)).toEqual({ uiLocale: "ar", token: "tok_abc" });
  });

  it("toute erreur est le même message générique, dans une région role=alert", () => {
    expect(renderToStaticMarkup(<AcceptInvitationForm token="t" />)).toMatch(/<div role="alert"[^>]*class="sr-only"/);
    stateOverride = { status: "error", code: "expired" };
    const html = renderToStaticMarkup(<AcceptInvitationForm token="t" />);
    expect(/<div role="alert"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1]).toContain("Invite:errors.invitation_invalid");
    expect(html).not.toContain("expired");
  });
});
