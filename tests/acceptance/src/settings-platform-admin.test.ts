import { beforeAll, describe, expect, it } from "vitest";
import { getPage, redirectPath, signIn, visibleText, type Session } from "./app-client";

/**
 * Paramétrage global (palette, logo) réservé aux administrateurs de la plateforme (ADR 016, condition levée).
 * Par HTTP avec une vraie session : un owner / admin d'organisation voit un message en lecture seule (aucun éditeur,
 * aucun lien « Paramétrage ») ; l'administrateur de la plateforme (compte seed `shared`) voit les éditeurs.
 * Le refus d'écriture lui-même est prouvé côté base (pgTAP, tests RLS) et dans les tests des actions.
 */

const sessions = new Map<string, Session>();
const as = (name: string): Session => {
  const session = sessions.get(name);
  if (!session) throw new Error(`session absente : ${name}`);
  return session;
};

beforeAll(async () => {
  for (const name of ["alpha-admin", "alpha-sales", "shared"]) sessions.set(name, await signIn(`${name}@seed.test`));
});

const PAGES = ["/fr/settings/appearance", "/fr/settings/logo"];

describe("sans session", () => {
  it("redirection vers la connexion", async () => {
    for (const path of PAGES) {
      const page = await getPage(null, path);
      expect(page.status, path).toBe(307);
      expect(redirectPath(page), path).toBe("/fr/login");
    }
  });
});

describe("owner / admin / commercial d'une organisation", () => {
  it("voient le message « réservé aux administrateurs de la plateforme », sans éditeur", async () => {
    for (const name of ["alpha-admin", "alpha-sales"]) {
      for (const path of PAGES) {
        const page = await getPage(as(name), path);
        expect(page.status, `${name} ${path}`).toBe(200);
        const text = visibleText(page);
        expect(text, `${name} ${path}`).toContain("Réservé aux administrateurs de la plateforme");
        expect(text, `${name} ${path}`).toContain("votre rôle d’organisation ne le permet pas");
        expect(text, `${name} ${path}`).not.toContain("Enregistrer la palette");
        expect(text, `${name} ${path}`).not.toContain("Choisir une image");
      }
    }
  });

  it("le menu latéral n'affiche pas « Paramétrage »", async () => {
    const page = await getPage(as("alpha-admin"), "/fr/dashboard");
    expect(page.status).toBe(200);
    expect(page.body).not.toContain('aria-controls="nav-settings-sub"');
  });
});

describe("administrateur de la plateforme", () => {
  it("voit l'éditeur de palette et le menu « Paramétrage »", async () => {
    const page = await getPage(as("shared"), "/fr/settings/appearance");
    expect(page.status).toBe(200);
    const text = visibleText(page);
    expect(text).toContain("Enregistrer la palette");
    expect(text).not.toContain("votre rôle d’organisation ne le permet pas");
    expect(page.body).toContain('aria-controls="nav-settings-sub"');
  });
});
