import { describe, expect, it } from "vitest";
import { captureLogs } from "./log-capture.testkit";
import { logger } from "./logger";
import { getRequestContext, requestIdHeaders, runWithRequestContext, updateRequestContext } from "./request-context";

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("request-context", () => {
  it("hors contexte : undefined, en-têtes vides, update sans effet", () => {
    expect(getRequestContext()).toBeUndefined();
    expect(requestIdHeaders()).toEqual({});
    expect(() => updateRequestContext({ actorId: "a" })).not.toThrow();
    expect(getRequestContext()).toBeUndefined();
  });

  it("se propage à travers les await, timers et promesses imbriquées", async () => {
    await runWithRequestContext({ requestId: "req-aaaaaaaa" }, async () => {
      expect(getRequestContext()?.requestId).toBe("req-aaaaaaaa");
      await tick(1);
      const ids = await Promise.all([tick(1).then(() => getRequestContext()?.requestId), Promise.resolve().then(() => getRequestContext()?.requestId)]);
      expect(ids).toEqual(["req-aaaaaaaa", "req-aaaaaaaa"]);
      expect(requestIdHeaders()).toEqual({ "x-request-id": "req-aaaaaaaa" });
    });
    expect(getRequestContext()).toBeUndefined();
  });

  it("updateRequestContext complète organisation et acteur, visibles ensuite (y compris dans le journal)", async () => {
    const cap = captureLogs();
    try {
      await runWithRequestContext({ requestId: "req-bbbbbbbb" }, async () => {
        await tick(1);
        updateRequestContext({ organizationId: "org-1", actorId: "user-1" });
        await tick(1);
        updateRequestContext({});
        expect(getRequestContext()).toEqual({ requestId: "req-bbbbbbbb", organizationId: "org-1", actorId: "user-1" });
        logger.info("after.update");
      });
      expect(cap.parsed()[0]).toMatchObject({ request_id: "req-bbbbbbbb", organization_id: "org-1", actor_id: "user-1" });
    } finally {
      cap.stop();
    }
  });

  it("deux requêtes concurrentes ne se contaminent jamais (identifiants, organisation, acteur, journaux)", async () => {
    const cap = captureLogs();
    try {
      const run = (id: string, org: string, delay: number) =>
        runWithRequestContext({ requestId: id }, async () => {
          await tick(delay);
          updateRequestContext({ organizationId: org, actorId: `actor-${id}` });
          await tick(5 - delay);
          logger.info("concurrent", { who: id });
          return { ...getRequestContext(), header: requestIdHeaders() };
        });
      const [a, b] = await Promise.all([run("req-aaaaaaaa", "org-A", 1), run("req-bbbbbbbb", "org-B", 4)]);
      expect(a).toMatchObject({ requestId: "req-aaaaaaaa", organizationId: "org-A", actorId: "actor-req-aaaaaaaa", header: { "x-request-id": "req-aaaaaaaa" } });
      expect(b).toMatchObject({ requestId: "req-bbbbbbbb", organizationId: "org-B", actorId: "actor-req-bbbbbbbb", header: { "x-request-id": "req-bbbbbbbb" } });
      expect(cap.parsed()).toHaveLength(2);
      for (const line of cap.parsed()) {
        const who = String(line.who);
        expect(line.request_id).toBe(who);
        expect(line.actor_id).toBe(`actor-${who}`);
        expect(line.organization_id).toBe(who === "req-aaaaaaaa" ? "org-A" : "org-B");
      }
    } finally {
      cap.stop();
    }
  });

  it("un contexte imbriqué est isolé et le parent est restauré ; l'objet d'entrée n'est pas partagé", async () => {
    const input = { requestId: "req-outer-01" };
    await runWithRequestContext(input, async () => {
      await runWithRequestContext({ requestId: "req-inner-01" }, async () => {
        updateRequestContext({ actorId: "inner" });
      });
      expect(getRequestContext()).toEqual({ requestId: "req-outer-01" });
      updateRequestContext({ actorId: "outer" });
    });
    expect(input).toEqual({ requestId: "req-outer-01" });
  });
});
