import { describe, expect, it } from "vitest";
import { ingestWebhook } from "../webhooks/ingest";
import type { WebhookStore } from "../webhooks/types";
import { postmarkWebhookAdapter } from "./postmark-webhook";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INT = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "acme-mail";
const SECRET = "secret-de-webhook-de-test-0123456789";
const encode = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
const DELIVERY = { RecordType: "Delivery", MessageID: "883953f4-6105-42a2-a16a-77a8eac79483", Recipient: "margareth@nasa.com", DeliveredAt: "2026-11-05T16:33:54.9070259Z" };

function fakeStore() {
  const events = new Map<string, { eventId: string; payload: unknown }>();
  const rejections: string[] = [];
  const resolved: string[] = [];
  const store: WebhookStore = {
    async resolve(_provider, account) {
      resolved.push(account);
      return account === ACCOUNT ? { organizationId: ORG, integrationId: INT } : null;
    },
    async record(input) {
      const key = `${input.organizationId}:${input.externalEventId}`;
      const existing = events.get(key);
      if (existing) return { eventId: existing.eventId, duplicate: true };
      const eventId = `evt-${events.size + 1}`;
      events.set(key, { eventId, payload: input.payload });
      return { eventId, duplicate: false };
    },
    async recordRejection({ organizationId }) {
      rejections.push(organizationId);
    },
  };
  return { store, events, rejections, resolved };
}

const ingest = (body: unknown, headers: Record<string, string | undefined>, fake = fakeStore(), secret: string | null = SECRET) =>
  ingestWebhook({ adapter: postmarkWebhookAdapter, rawBody: encode(body), headers, store: fake.store, readSecret: async () => secret });

describe("adaptateur webhook Postmark : authentification Basic", () => {
  const verify = (authorization: string | undefined, secret: string | null) =>
    postmarkWebhookAdapter.verify({ rawBody: new Uint8Array(), headers: { authorization }, secret });

  it("le bon mot de passe passe ; un autre, un en-tête absent ou mal formé, ou un secret absent ne passent pas", () => {
    expect(verify(basic(ACCOUNT, SECRET), SECRET)).toBe(true);
    expect(verify(basic(ACCOUNT, `${SECRET}x`), SECRET)).toBe(false);
    expect(verify(basic(ACCOUNT, ""), SECRET)).toBe(false);
    expect(verify(undefined, SECRET)).toBe(false);
    expect(verify("Bearer abc", SECRET)).toBe(false);
    expect(verify("Basic !!!pas-du-base64", SECRET)).toBe(false);
    expect(verify(`Basic ${Buffer.from("sans-deux-points").toString("base64")}`, SECRET)).toBe(false);
    expect(verify(basic(ACCOUNT, SECRET), null)).toBe(false);
    expect(verify(basic(ACCOUNT, SECRET), "")).toBe(false);
  });

  it("un mot de passe qui contient « : » est accepté tel quel", () => {
    expect(verify(basic(ACCOUNT, "a:b:c-secret-long-0123456789"), "a:b:c-secret-long-0123456789")).toBe(true);
  });

  it("le compte est l'utilisateur Basic : forme stricte, sinon aucun compte", () => {
    const account = (authorization: string | undefined) => postmarkWebhookAdapter.extractAccount({}, { authorization });
    expect(account(basic(ACCOUNT, "x"))).toBe(ACCOUNT);
    expect(account(basic("compte invalide !", "x"))).toBeNull();
    expect(account(basic("", "x"))).toBeNull();
    expect(account(basic("a".repeat(101), "x"))).toBeNull();
    expect(account(undefined)).toBeNull();
    expect(account(`Basic ${"A".repeat(700)}`)).toBeNull();
  });

  it("parse : JSON invalide ou UTF-8 invalide = refus ; l'identifiant d'événement vient du contenu normalisé", () => {
    expect(postmarkWebhookAdapter.parse(encode("pas du json"))).toBeNull();
    expect(postmarkWebhookAdapter.parse(new Uint8Array([0xff, 0xfe, 0xfd]))).toBeNull();
    expect(postmarkWebhookAdapter.parse(encode({ RecordType: "Delivery" }))).toBeNull();
    const payload = postmarkWebhookAdapter.parse(encode(DELIVERY));
    expect(postmarkWebhookAdapter.extractEventId(payload, {})).toMatch(/^delivery:883953f4/);
    expect(postmarkWebhookAdapter.extractEventId(null, {})).toBeNull();
    expect(postmarkWebhookAdapter.extractEventId({ eventId: 4 }, {})).toBeNull();
  });
});

describe("adaptateur Postmark dans le pipeline commun (J29)", () => {
  it("authentifié : l'événement NORMALISÉ est enregistré (pas le corps brut), pour l'entreprise de l'intégration", async () => {
    const fake = fakeStore();
    const outcome = await ingest({ ...DELIVERY, Details: "250 2.0.0 OK", Tag: "t" }, { authorization: basic(ACCOUNT, SECRET) }, fake);
    expect(outcome.kind).toBe("accepted");
    expect([...fake.events.values()][0]?.payload).toMatchObject({ kind: "delivered", recipient: "margareth@nasa.com" });
    expect(JSON.stringify([...fake.events.values()])).not.toContain("250 2.0.0");
  });

  it("le même événement rejoué : duplicate, sans second enregistrement", async () => {
    const fake = fakeStore();
    const headers = { authorization: basic(ACCOUNT, SECRET) };
    expect((await ingest(DELIVERY, headers, fake)).kind).toBe("accepted");
    expect((await ingest(DELIVERY, headers, fake)).kind).toBe("duplicate");
    expect(fake.events.size).toBe(1);
  });

  it("mauvais mot de passe : refus 401 et trace sans payload ; aucun événement enregistré", async () => {
    const fake = fakeStore();
    const outcome = await ingest(DELIVERY, { authorization: basic(ACCOUNT, "mauvais") }, fake);
    expect(outcome.kind).toBe("invalid_signature");
    expect(fake.events.size).toBe(0);
    expect(fake.rejections).toEqual([ORG]);
  });

  it("compte inconnu : le MÊME refus qu'un mauvais mot de passe, sans trace ni enregistrement", async () => {
    const fake = fakeStore();
    const outcome = await ingest(DELIVERY, { authorization: basic("inconnu", SECRET) }, fake);
    expect(outcome.kind).toBe("invalid_signature");
    expect(fake.events.size).toBe(0);
    expect(fake.rejections).toHaveLength(0);
  });

  it("sans en-tête d'autorisation : requête invalide (aucun compte) ; intégration sans secret : refus", async () => {
    expect((await ingest(DELIVERY, {})).kind).toBe("bad_request");
    expect((await ingest(DELIVERY, { authorization: basic(ACCOUNT, SECRET) }, fakeStore(), null)).kind).toBe("invalid_signature");
  });

  it("événement d'un autre type : acquitté (200) puis ignoré ; corps trop gros : 413 ; JSON invalide : 400", async () => {
    const fake = fakeStore();
    const headers = { authorization: basic(ACCOUNT, SECRET) };
    expect((await ingest({ RecordType: "Open", MessageID: "x" }, headers, fake)).kind).toBe("accepted");
    expect([...fake.events.values()][0]?.payload).toMatchObject({ kind: "ignored" });
    expect((await ingest("x".repeat(5 * 1024 * 1024 + 1), headers)).kind).toBe("too_large");
    expect((await ingest("pas du json", headers)).kind).toBe("bad_request");
  });

  it("l'entreprise n'est JAMAIS tirée du payload : un champ organization_id du corps est sans effet", async () => {
    const fake = fakeStore();
    await ingest({ ...DELIVERY, organization_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, { authorization: basic(ACCOUNT, SECRET) }, fake);
    expect(fake.resolved).toEqual([ACCOUNT]);
    expect(JSON.stringify([...fake.events.values()])).not.toContain("bbbbbbbb");
  });
});
