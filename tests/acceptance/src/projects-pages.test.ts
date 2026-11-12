import { beforeAll, describe, expect, it } from "vitest";
import { ORG, PROJECT } from "../../../supabase/tests/rls/src/harness";
import { getPage, redirectPath, signIn, visibleText, type Session } from "./app-client";

/**
 * Écran Projets (J17) par HTTP avec une vraie session : liste et détail selon le rôle, entreprise active, isolation
 * Alpha / Beta (un identifiant d'une autre entreprise donne la même page « introuvable » qu'un identifiant inconnu).
 */

const sessions = new Map<string, Session>();
const as = (name: string): Session => {
  const session = sessions.get(name);
  if (!session) throw new Error(`session absente : ${name}`);
  return session;
};

beforeAll(async () => {
  for (const name of ["alpha-admin", "alpha-analyst", "alpha-sales", "alpha-marketing", "beta-owner", "shared"]) {
    sessions.set(name, await signIn(`${name}@seed.test`));
  }
});

describe("liste des projets", () => {
  it("sans session : redirection vers la connexion", async () => {
    for (const path of ["/fr/projects", "/fr/projects/new", `/fr/projects/${PROJECT.alphaSite}`]) {
      const page = await getPage(null, path);
      expect(page.status, path).toBe(307);
      expect(redirectPath(page), path).toBe("/fr/login");
    }
  });

  it("l'administrateur d'Alpha voit les projets d'Alpha et le bouton de création, rien de Beta", async () => {
    const page = await getPage(as("alpha-admin"), "/fr/projects");
    expect(page.status).toBe(200);
    const text = visibleText(page);
    expect(text).toContain("Site vitrine Alpha");
    expect(text).toContain("Application Salla Alpha");
    expect(text).not.toContain("Boutique en ligne Beta");
    expect(page.body).not.toContain(ORG.beta);
    expect(page.body).not.toContain(PROJECT.betaShop);
    expect(page.body).toContain('href="/fr/projects/new"');
  });

  it("analyste, commercial et marketing : lecture seule (liste visible, aucun bouton de création)", async () => {
    for (const name of ["alpha-analyst", "alpha-sales", "alpha-marketing"]) {
      const page = await getPage(as(name), "/fr/projects");
      expect(page.status, name).toBe(200);
      expect(visibleText(page), name).toContain("Site vitrine Alpha");
      expect(page.body, name).not.toContain('href="/fr/projects/new"');
    }
  });

  it("le propriétaire de Beta ne voit que Beta", async () => {
    const page = await getPage(as("beta-owner"), "/fr/projects");
    const text = visibleText(page);
    expect(text).toContain("Boutique en ligne Beta");
    expect(text).toContain("Thème Salla Beta");
    expect(text).not.toContain("Site vitrine Alpha");
    expect(page.body).not.toContain(PROJECT.alphaSite);
  });

  it("l'utilisateur à deux rôles suit l'entreprise active : Beta (commercial) lecture seule, Alpha (propriétaire) avec création", async () => {
    const beta = await getPage(as("shared"), "/fr/projects", ORG.beta);
    expect(visibleText(beta)).toContain("Boutique en ligne Beta");
    expect(visibleText(beta)).not.toContain("Site vitrine Alpha");
    expect(beta.body).not.toContain('href="/fr/projects/new"');
    const alpha = await getPage(as("shared"), "/fr/projects", ORG.alpha);
    expect(visibleText(alpha)).toContain("Site vitrine Alpha");
    expect(alpha.body).toContain('href="/fr/projects/new"');
  });

  it("filtre : la vue « Archivés » ne contient aucun projet actif", async () => {
    const page = await getPage(as("alpha-admin"), "/fr/projects?status=archived");
    expect(page.status).toBe(200);
    expect(visibleText(page)).not.toContain("Site vitrine Alpha");
  });
});

describe("création", () => {
  it("owner et admin ouvrent le formulaire ; analyste, commercial, marketing sont renvoyés vers la liste", async () => {
    const ok = await getPage(as("alpha-admin"), "/fr/projects/new");
    expect(ok.status).toBe(200);
    expect(visibleText(ok)).toContain("Nouveau projet");
    for (const name of ["alpha-analyst", "alpha-sales", "alpha-marketing"]) {
      const page = await getPage(as(name), "/fr/projects/new");
      expect(page.status, name).toBe(307);
      expect(redirectPath(page), name).toBe("/fr/projects");
    }
  });
});

describe("page d'un projet", () => {
  it("l'administrateur voit les réglages, les produits et les actions", async () => {
    const page = await getPage(as("alpha-admin"), `/fr/projects/${PROJECT.alphaSite}`);
    expect(page.status).toBe(200);
    const text = visibleText(page);
    expect(text).toContain("Site vitrine Alpha");
    expect(text).toContain("Produits et offres");
    expect(text).toContain("Archiver");
    expect(text).toContain("Ajouter un produit");
    expect(text).toContain("Site vitrine en 5 jours");
  });

  it("l'analyste lit le projet sans aucune action d'écriture", async () => {
    const page = await getPage(as("alpha-analyst"), `/fr/projects/${PROJECT.alphaSite}`);
    expect(page.status).toBe(200);
    const text = visibleText(page);
    expect(text).toContain("Site vitrine Alpha");
    expect(text).not.toContain("Archiver");
    expect(text).not.toContain("Ajouter un produit");
    expect(text).not.toContain("Modifier");
    expect(text).not.toMatch(/Enregistrer\b/);
  });

  it("projet d'une autre entreprise, identifiant inconnu ou illisible : la même page « introuvable », sans fuite", async () => {
    const foreign = await getPage(as("beta-owner"), `/fr/projects/${PROJECT.alphaSite}`);
    const unknown = await getPage(as("beta-owner"), "/fr/projects/00000000-0000-4000-8000-0000000000ff");
    const garbage = await getPage(as("beta-owner"), "/fr/projects/pas-un-uuid");
    for (const page of [foreign, unknown, garbage]) {
      expect(page.status).toBe(404);
      // (l'identifiant demandé est celui de l'URL du client : il peut réapparaître dans la page d'erreur, mais rien du projet)
      expect(page.body).not.toContain("Site vitrine Alpha");
      expect(page.body).not.toContain(ORG.alpha);
      expect(page.body).not.toContain("Pack vitrine");
    }
  });

  it("l'indice d'entreprise ne donne pas accès au projet d'une autre entreprise", async () => {
    const page = await getPage(as("shared"), `/fr/projects/${PROJECT.betaShop}`, ORG.alpha);
    expect(page.status).toBe(404);
    expect(visibleText(page)).not.toContain("Boutique en ligne Beta");
  });
});
