import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, ORG, restoreFixtures, snapshotFixtures, USER, type Snapshot } from "../../../supabase/tests/rls/src/harness";
import { getPage, redirectPath, signIn, type Session } from "./app-client";

/**
 * T5 (docs/testing/strategy.md §5) : changement d'entreprise en session, puis lien profond de l'ancienne entreprise.
 * L'entreprise active est un INDICE (cookie) confronté à chaque requête aux adhésions ACTIVES relues en base
 * (ADR 005 §7) : un indice périmé, falsifié ou une adhésion/un rôle retiré en cours de session ne donne rien.
 */

const A = ORG.alpha;
const B = ORG.beta;
let shared: Session;
let betaOwner: Session;
let snapshot: Snapshot;

beforeAll(async () => {
  snapshot = await snapshotFixtures();
  shared = await signIn("shared@seed.test");
  betaOwner = await signIn("beta-owner@seed.test");
});
afterAll(async () => {
  await restoreFixtures(snapshot);
});

describe("T5 · changement d'entreprise en session", () => {
  it("dans Alpha (owner), la page Membres est servie", async () => {
    const page = await getPage(shared, "/fr/members", A);
    expect(page.status).toBe(200);
  });

  it("sans indice, deux entreprises : choix obligatoire (jamais une entreprise devinée)", async () => {
    const page = await getPage(shared, "/fr/members");
    expect(page.status).toBe(307);
    expect(redirectPath(page)).toBe("/fr/select-organization");
  });

  it("après bascule vers Beta (sales agent), le lien profond d'Alpha ne rend plus la page d'Alpha", async () => {
    const deepLink = await getPage(shared, `/fr/members?organization_id=${A}`, B);
    expect(deepLink.status).toBe(307);
    expect(redirectPath(deepLink)).toBe("/fr/dashboard");
  });

  it("le même utilisateur retrouve Alpha en rebasculant : l'état ne colle pas à l'ancien contexte", async () => {
    expect((await getPage(shared, "/fr/members", B)).status).toBe(307);
    expect((await getPage(shared, "/fr/members", A)).status).toBe(200);
  });

  it("un indice qui n'est pas un identifiant est ignoré (traité comme absent)", async () => {
    for (const hint of ["not-a-uuid", "..%2F..%2Fetc%2Fpasswd", `${A}%00`]) {
      const page = await getPage(shared, "/fr/members", hint);
      expect(redirectPath(page)).toBe("/fr/select-organization");
    }
  });

  it("indice vers une entreprise inexistante ou étrangère : refusé", async () => {
    const unknown = await getPage(shared, "/fr/members", "c0000000-0000-4000-8000-0000000000c1");
    expect(redirectPath(unknown)).toBe("/fr/select-organization");
    const foreign = await getPage(betaOwner, "/fr/members", A);
    expect(redirectPath(foreign)).toBe("/fr/select-organization");
  });
});

describe("T5 · l'autorisation est revérifiée à chaque requête", () => {
  it("rôle rétrogradé en cours de session : la page Membres d'Alpha n'est plus servie", async () => {
    const admin = await signIn("alpha-admin@seed.test");
    expect((await getPage(admin, "/fr/members")).status).toBe(200);
    const demote = await api("service", "PATCH", `organization_members?organization_id=eq.${A}&user_id=eq.${USER.alphaAdmin}`, { role: "analyst" });
    expect(demote.status).toBeLessThan(300);
    try {
      const page = await getPage(admin, "/fr/members");
      expect(page.status).toBe(307);
      expect(redirectPath(page)).toBe("/fr/dashboard");
    } finally {
      await restoreFixtures(snapshot);
    }
  });

  it("adhésion à Beta retirée en cours de session : l'ancien indice vers Beta est refusé", async () => {
    expect((await getPage(shared, "/fr/dashboard", B)).status).toBe(200);
    const removed = await api("service", "DELETE", `organization_members?organization_id=eq.${B}&user_id=eq.${USER.shared}`);
    expect(removed.status).toBeLessThan(300);
    try {
      const page = await getPage(shared, "/fr/dashboard", B);
      expect(page.status).toBe(307);
      expect(redirectPath(page)).toBe("/fr/select-organization");
    } finally {
      await restoreFixtures(snapshot);
    }
  });

  it("entreprise suspendue : plus d'accès à ses pages", async () => {
    const suspend = await api("service", "PATCH", `organizations?id=eq.${B}`, { status: "suspended" });
    expect(suspend.status).toBeLessThan(300);
    try {
      const page = await getPage(betaOwner, "/fr/dashboard", B);
      expect(page.status).toBe(307);
      expect(redirectPath(page)).toBe("/fr/select-organization");
    } finally {
      await api("service", "PATCH", `organizations?id=eq.${B}`, { status: "active" });
      await restoreFixtures(snapshot);
    }
  });
});
