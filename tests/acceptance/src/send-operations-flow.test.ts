import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORG, psql, purgeIdempotencyKeys } from "../../../supabase/tests/rls/src/harness";
import { getPage, postJson, redirectPath, signIn, visibleText, type Session } from "./app-client";

/**
 * Exploitation des envois (J39) par HTTP, avec de vraies sessions : arrêt d'urgence (owner, admin, marketing ; pas commercial ni analyste),
 * rejeu d'une dead letter (owner et admin), isolation Alpha / Beta, rejouabilité par Idempotency-Key.
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const KEY_PREFIX = `acc39${run}`;
const sessions = new Map<string, Session>();
const as = (who: string): Session => {
  const session = sessions.get(who);
  if (!session) throw new Error(`session absente : ${who}`);
  return session;
};
let counter = 0;
const post = (who: string | null, path: string, payload: unknown, opts: { org?: string; key?: string | null } = {}) =>
  postJson(who ? as(who) : null, path, payload, {
    activeOrg: opts.org ?? ORG.alpha,
    headers: opts.key === null ? {} : { "idempotency-key": opts.key ?? `${KEY_PREFIX}-${(counter += 1)}-${randomUUID()}` },
  });
const first = (sql: string): string => psql(sql).trim().split("\n").filter((l) => l.length > 0)[0] ?? "";
const paused = (org: string) => first(`select coalesce(settings ->> 'send_paused', 'false') from public.organizations where id = '${org}'`);
// remise à zéro hors API : S-05 interdit d'écrire settings.send_paused hors de set_send_emergency_stop ; ce nettoyage de test lève le levier local à la transaction (comme la fonction)
const resume = (org: string) =>
  psql(`begin; select set_config('fusion.send_pause_via_function', 'on', true); update public.organizations set settings = settings - 'send_paused' where id = '${org}'; commit;`);
const deadLetter = (org: string, k: string): string => {
  const id = first(`insert into public.jobs (organization_id, kind, payload, idempotency_key, status) values ('${org}', 'noop', '{}', '${KEY_PREFIX}-job-${k}', 'queued') returning id`);
  psql(`update public.jobs set status = 'dead_letter', finished_at = now(), last_error = 'provider_error' where id = '${id}'`);
  return id;
};

const cleanup = () => {
  resume(ORG.alpha);
  resume(ORG.beta);
  psql(`delete from public.notifications where kind = 'send.failed' and organization_id in ('${ORG.alpha}', '${ORG.beta}')`);
  psql(`delete from public.jobs where idempotency_key like '${KEY_PREFIX}-job-%'`);
  purgeIdempotencyKeys(KEY_PREFIX);
};

beforeAll(async () => {
  cleanup();
  for (const name of ["shared", "alpha-admin", "alpha-marketing", "alpha-sales", "alpha-analyst", "beta-owner"]) sessions.set(name, await signIn(`${name}@seed.test`));
});
afterAll(cleanup);

describe("arrêt d'urgence", () => {
  it("commercial et analyste : 403 ; anonyme : 401 ; sans clé, corps invalide ou organization_id : 400 ; rien n'est modifié", async () => {
    for (const who of ["alpha-sales", "alpha-analyst"]) expect((await post(who, "/api/send/emergency-stop", { paused: true })).status, who).toBe(403);
    expect((await post(null, "/api/send/emergency-stop", { paused: true })).status).toBe(401);
    expect((await post("shared", "/api/send/emergency-stop", { paused: true }, { key: null })).status).toBe(400);
    expect((await post("shared", "/api/send/emergency-stop", { paused: "oui" })).status).toBe(400);
    expect((await post("shared", "/api/send/emergency-stop", { paused: true, organization_id: ORG.beta })).status).toBe(400);
    expect(paused(ORG.alpha)).toBe("false");
  });

  it("marketing, admin et propriétaire arrêtent ; admin et propriétaire relancent (S-05 : le marketing ne reprend pas) ; seule l'entreprise active est touchée", async () => {
    for (const who of ["alpha-marketing", "alpha-admin", "shared"]) {
      const stop = await post(who, "/api/send/emergency-stop", { paused: true });
      expect(stop.status, who).toBe(200);
      expect(stop.json).toEqual({ paused: true });
      expect(paused(ORG.alpha), who).toBe("true");
      expect(paused(ORG.beta), who).not.toBe("true");
      if (who === "alpha-marketing") {
        // le marketing ne peut pas reprendre : 403, l'arrêt reste actif ; un administrateur reprend
        expect((await post(who, "/api/send/emergency-stop", { paused: false })).status, who).toBe(403);
        expect(paused(ORG.alpha), who).toBe("true");
        expect((await post("alpha-admin", "/api/send/emergency-stop", { paused: false })).status).toBe(200);
      } else {
        expect((await post(who, "/api/send/emergency-stop", { paused: false })).status, who).toBe(200);
      }
      expect(paused(ORG.alpha), who).toBe("false");
    }
  });

  it("l'audit nomme l'acteur ; la même clé d'idempotence rejoue la même réponse sans second effet", async () => {
    const key = `${KEY_PREFIX}-same-${randomUUID()}`;
    const before = first(`select count(*) from public.audit_logs where organization_id = '${ORG.alpha}' and action = 'send.emergency_stop'`);
    const a = await post("alpha-admin", "/api/send/emergency-stop", { paused: true }, { key });
    const b = await post("alpha-admin", "/api/send/emergency-stop", { paused: true }, { key });
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(Number(first(`select count(*) from public.audit_logs where organization_id = '${ORG.alpha}' and action = 'send.emergency_stop'`))).toBe(Number(before) + 1);
    resume(ORG.alpha);
  });
});

describe("rejeu d'une dead letter", () => {
  it("commercial, marketing, analyste : 403 ; anonyme : 401 ; identifiant invalide ou organization_id : 400", async () => {
    const id = deadLetter(ORG.alpha, "deny");
    for (const who of ["alpha-sales", "alpha-marketing", "alpha-analyst"]) {
      expect((await post(who, "/api/jobs/dead-letters/replay", { job_id: id })).status, who).toBe(403);
    }
    expect((await post(null, "/api/jobs/dead-letters/replay", { job_id: id })).status).toBe(401);
    expect((await post("shared", "/api/jobs/dead-letters/replay", { job_id: "pas-un-uuid" })).status).toBe(400);
    expect((await post("shared", "/api/jobs/dead-letters/replay", { job_id: id, organization_id: ORG.alpha })).status).toBe(400);
    expect(first(`select status from public.jobs where id = '${id}'`)).toBe("dead_letter");
  });

  it("l'admin rejoue : le job repart en file ; un second rejeu et un job d'une autre entreprise répondent 404", async () => {
    const id = deadLetter(ORG.alpha, "ok");
    expect((await post("alpha-admin", "/api/jobs/dead-letters/replay", { job_id: id })).status).toBe(200);
    expect(first(`select status from public.jobs where id = '${id}'`)).toBe("queued");
    expect((await post("alpha-admin", "/api/jobs/dead-letters/replay", { job_id: id })).status).toBe(404);
    const foreign = deadLetter(ORG.beta, "foreign");
    expect((await post("shared", "/api/jobs/dead-letters/replay", { job_id: foreign })).status).toBe(404);
    expect((await post("beta-owner", "/api/jobs/dead-letters/replay", { job_id: id }, { org: ORG.beta })).status).toBe(404);
    expect(first(`select status from public.jobs where id = '${foreign}'`)).toBe("dead_letter");
  });
});

describe("page Exploitation", () => {
  it("commercial et analyste reviennent au tableau de bord ; un anonyme à la connexion", async () => {
    for (const who of ["alpha-sales", "alpha-analyst"]) expect(redirectPath(await getPage(as(who), "/en/operations", ORG.alpha)), who).toMatch(/dashboard/);
    expect(redirectPath(await getPage(null, "/en/operations", ORG.alpha))).toMatch(/login/);
  });

  it("l'admin voit l'arrêt d'urgence et la dead letter (sans charge utile) ; le marketing voit l'arrêt mais pas les dead letters", async () => {
    const id = deadLetter(ORG.alpha, "page");
    const admin = await getPage(as("alpha-admin"), "/en/operations", ORG.alpha);
    expect(admin.status).toBe(200);
    const text = visibleText(admin);
    expect(text).toContain("Emergency stop");
    expect(text).toContain("Replay");
    expect(text).toContain("provider_error");
    expect(admin.body).not.toContain(id.replace(/-/g, "") + "secret");
    const marketing = await getPage(as("alpha-marketing"), "/en/operations", ORG.alpha);
    expect(marketing.status).toBe(200);
    expect(visibleText(marketing)).toContain("Emergency stop");
    expect(visibleText(marketing)).toContain("Only owners and admins can see and replay failed jobs.");
    expect(visibleText(marketing)).not.toContain("provider_error");
  });

  it("l'arrêt actif est annoncé sur la page", async () => {
    expect((await post("shared", "/api/send/emergency-stop", { paused: true })).status).toBe(200);
    expect(visibleText(await getPage(as("alpha-admin"), "/en/operations", ORG.alpha))).toContain("Sending is STOPPED");
    resume(ORG.alpha);
  });
});
