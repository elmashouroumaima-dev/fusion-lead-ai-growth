import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKeyRing } from "../../../packages/adapters/src/secrets";
import { createUnsubscribeToken } from "../../../packages/adapters/src/email/unsubscribe";
import { api, ORG, psql } from "../../../supabase/tests/rls/src/harness";
import { BASE_URL } from "./app-client";

/**
 * Désabonnement (J33, spec §9.2) de bout en bout, SANS session : la VRAIE route `/api/unsubscribe/[token]` (lien de l'e-mail, un clic RFC 8058),
 * la VRAIE page publique `/{langue}/unsubscribe/[token]` et les VRAIES fonctions SQL. Scénarios : le lien ne désabonne pas à l'ouverture,
 * la page est publique (pas de redirection vers la connexion) dans les trois langues, jeton falsifié / corps invalide / entreprise du jeton
 * incohérente : 400 et rien d'écrit, un clic : consentements révoqués + adresse supprimée + envoi en file annulé (job compris), les autres
 * contacts intacts, deuxième clic : même résultat sans second effet.
 * Exige la clé maître (SECRETS_MASTER_KEY, la même que celle de l'application) : sans elle, le flux entier est ignoré.
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const MASTER = process.env.SECRETS_MASTER_KEY;
const VERSION = Number(process.env.SECRETS_KEY_VERSION ?? "1");
const keyRing = MASTER ? createKeyRing(VERSION, { [VERSION]: MASTER }) : null;
const IP = "203.0.113.33";
const DOMAIN = `un${run}.test`;

const rpc = <T = unknown>(fn: string, args: Record<string, unknown>) => api<T>("service", "POST", `rpc/${fn}`, args);
const oneClick = (token: string, body = "List-Unsubscribe=One-Click") =>
  fetch(`${BASE_URL}/api/unsubscribe/${token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": IP }, body });

let integration = "";
let channel = "";
const contact: Record<string, string> = {};
const message: Record<string, string> = {};
const queued: Record<string, string> = {};
const tokenFor = (org: string, key: string) => createUnsubscribeToken(keyRing as NonNullable<typeof keyRing>, { organizationId: org, messageId: message[key] as string });

const cleanup = () => {
  // les consentements sont en ajout seul (déclencheur) : le nettoyage de test passe en mode « réplica » (déclencheurs et clés étrangères suspendus)
  psql(`
    begin;
    set local session_replication_role = replica;
    delete from public.jobs where payload ->> 'message_id' in (select id::text from public.messages where conversation_id in (select id from public.conversations where contact_id in (select id from public.contacts where email_normalized like '%@${DOMAIN}')));
    delete from public.suppressions where value_normalized like '%@${DOMAIN}';
    delete from public.consent_events where contact_id in (select id from public.contacts where email_normalized like '%@${DOMAIN}');
    delete from public.messages where conversation_id in (select id from public.conversations where contact_id in (select id from public.contacts where email_normalized like '%@${DOMAIN}'));
    delete from public.conversations where contact_id in (select id from public.contacts where email_normalized like '%@${DOMAIN}');
    delete from public.channels where sender_identity like '%@${DOMAIN}';
    delete from public.integrations where external_account_id like 'acc33${run}%';
    delete from public.contacts where email_normalized like '%@${DOMAIN}';
    commit;
  `);
};

const consents = (key: string) => Number(psql(`select count(*) from public.consent_events where contact_id = '${contact[key]}' and channel = 'email' and revoked_at is null`));
const suppressed = (key: string) => Number(psql(`select count(*) from public.suppressions where organization_id = '${ORG.alpha}' and value_normalized = '${key}@${DOMAIN}'`));
const status = (id: string) => psql(`select status from public.messages where id = '${id}'`);
const jobStatus = (id: string) => psql(`select status from public.jobs where payload ->> 'message_id' = '${id}'`);

beforeAll(async () => {
  cleanup();
  if (!keyRing) return;
  psql(`
    insert into public.integrations (organization_id, provider, status, external_account_id) values ('${ORG.alpha}', 'email', 'active', 'acc33${run}');
    insert into public.channels (organization_id, type, integration_id, sender_identity, status)
      select '${ORG.alpha}', 'email', id, 'ventes@${DOMAIN}', 'active' from public.integrations where external_account_id = 'acc33${run}';
    insert into public.contacts (organization_id, name, email_raw, email_normalized) values
      ('${ORG.alpha}', 'UN K1 ${run}', 'k1@${DOMAIN}', 'k1@${DOMAIN}'),
      ('${ORG.alpha}', 'UN K2 ${run}', 'k2@${DOMAIN}', 'k2@${DOMAIN}');
  `);
  integration = psql(`select id from public.integrations where external_account_id = 'acc33${run}'`);
  channel = psql(`select id from public.channels where integration_id = '${integration}'`);
  for (const key of ["k1", "k2"]) {
    contact[key] = psql(`select id from public.contacts where email_normalized = '${key}@${DOMAIN}'`);
    psql(`insert into public.consent_events (organization_id, contact_id, channel, purpose, source) values ('${ORG.alpha}', '${contact[key]}', 'email', 'marketing', 'form')`);
    const conv = String(((await rpc("conversation_get_or_create", { p_org: ORG.alpha, p_contact: contact[key], p_channel: channel })).body as { id: string }).id);
    for (const kind of ["sent", "queued"]) {
      const recorded = await rpc<{ message_id: string }>("message_record", {
        p_org: ORG.alpha, p_conversation: conv, p_direction: "outbound", p_provider_message_id: null, p_body: `Bonjour ${key} ${kind}`, p_idempotency_key: `acc33-${run}-${key}-${kind}`, p_event_at: null,
      });
      const id = recorded.body.message_id;
      const accepted = kind === "sent" ? ", status = 'accepted', provider_message_id = 'pm-" + run + "-" + key + "', send_claimed_at = now(), sent_at = now()" : "";
      psql(`update public.messages set approved_by = (select id from auth.users where email = 'shared@seed.test'), approved_at = now(), approved_purpose = 'marketing', approved_recipient = '${key}@${DOMAIN}'${accepted} where id = '${id}'`);
      if (kind === "sent") message[key] = id;
      else {
        queued[key] = id;
        psql(`select private.enqueue_job('${ORG.alpha}', 'send_message', jsonb_build_object('message_id', '${id}'), 'send-message:acc33-${run}-${key}', null, 5)`);
      }
    }
  }
});
afterAll(cleanup);

describe.skipIf(!keyRing)("désabonnement public", () => {
  it("le lien de l'e-mail (GET) renvoie vers la page de confirmation et NE désabonne PAS", async () => {
    const res = await fetch(`${BASE_URL}/api/unsubscribe/${tokenFor(ORG.alpha, "k1")}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(`/fr/unsubscribe/${tokenFor(ORG.alpha, "k1")}`);
    expect(consents("k1")).toBe(1);
    expect(suppressed("k1")).toBe(0);
    expect(status(queued.k1 as string)).toBe("queued");
  });

  it("la page est publique (aucune redirection vers la connexion) dans les trois langues et ne désabonne pas à l'affichage", async () => {
    const token = tokenFor(ORG.alpha, "k1");
    for (const [locale, text] of [["fr", "Me désabonner"], ["en", "Unsubscribe me"], ["ar", "إلغاء اشتراكي"]] as const) {
      const res = await fetch(`${BASE_URL}/${locale}/unsubscribe/${token}`, { redirect: "manual" });
      expect(res.status, locale).toBe(200);
      expect(await res.text(), locale).toContain(text);
    }
    expect(consents("k1")).toBe(1);
  });

  it("jeton falsifié : la page dit « lien invalide » (200, publique) et la route un clic répond 400, rien n'est écrit", async () => {
    const good = tokenFor(ORG.alpha, "k1");
    const bad = good.slice(0, -1) + (good.endsWith("A") ? "B" : "A");
    const page = await fetch(`${BASE_URL}/fr/unsubscribe/${bad}`, { redirect: "manual" });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Lien invalide");
    expect((await oneClick(bad)).status).toBe(400);
    expect(consents("k1")).toBe(1);
  });

  it("corps absent ou différent de List-Unsubscribe=One-Click : 400, rien n'est écrit", async () => {
    for (const body of ["", "x=1", "List-Unsubscribe=No"]) expect((await oneClick(tokenFor(ORG.alpha, "k1"), body)).status, body).toBe(400);
    expect(consents("k1")).toBe(1);
  });

  it("un jeton signé qui revendique une AUTRE entreprise que celle du message : 400, rien n'est écrit (l'entreprise n'est jamais crue)", async () => {
    const crossed = createUnsubscribeToken(keyRing as NonNullable<typeof keyRing>, { organizationId: ORG.beta, messageId: message.k1 as string });
    expect((await oneClick(crossed)).status).toBe(400);
    expect(consents("k1")).toBe(1);
    expect(suppressed("k1")).toBe(0);
  });

  it("un clic : 200 ; consentements révoqués, adresse supprimée, envoi en file annulé avec son job ; l'autre contact intact", async () => {
    const res = await oneClick(tokenFor(ORG.alpha, "k1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(consents("k1")).toBe(0);
    expect(suppressed("k1")).toBe(1);
    expect(psql(`select reason from public.suppressions where organization_id = '${ORG.alpha}' and value_normalized = 'k1@${DOMAIN}'`)).toBe("unsubscribe");
    expect(status(queued.k1 as string)).toBe("cancelled");
    expect(jobStatus(queued.k1 as string)).toBe("cancelled");
    expect(status(message.k1 as string)).toBe("accepted");
    // k2 : rien n'a bougé
    expect(consents("k2")).toBe(1);
    expect(suppressed("k2")).toBe(0);
    expect(status(queued.k2 as string)).toBe("queued");
    expect(jobStatus(queued.k2 as string)).toBe("queued");
  });

  it("deuxième clic : 200 sans second effet ; la page confirme sans rien révéler", async () => {
    expect((await oneClick(tokenFor(ORG.alpha, "k1"))).status).toBe(200);
    expect(suppressed("k1")).toBe(1);
    expect(Number(psql(`select count(*) from public.audit_logs where organization_id = '${ORG.alpha}' and action = 'unsubscribe.applied' and after ->> 'source_message_id' = '${message.k1}'`))).toBe(1);
    const page = await fetch(`${BASE_URL}/fr/unsubscribe/${tokenFor(ORG.alpha, "k1")}?result=done`, { redirect: "manual" });
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain("désabonné");
    expect(html).not.toContain(`k1@${DOMAIN}`);
  });

  it("le message suivant du contact désabonné est refusé à la réclamation (pas de consentement, adresse supprimée)", async () => {
    const recorded = await rpc<{ message_id: string }>("message_record", {
      p_org: ORG.alpha, p_conversation: psql(`select id from public.conversations where contact_id = '${contact.k1}'`), p_direction: "outbound", p_provider_message_id: null,
      p_body: "Après désabonnement", p_idempotency_key: `acc33-${run}-k1-after`, p_event_at: null,
    });
    psql(`update public.messages set approved_by = (select id from auth.users where email = 'shared@seed.test'), approved_at = now(), approved_purpose = 'marketing', approved_recipient = 'k1@${DOMAIN}' where id = '${recorded.body.message_id}'`);
    const claim = await rpc<{ status: string; consent: boolean; suppressed: boolean }>("message_send_claim", { p_org: ORG.alpha, p_message: recorded.body.message_id });
    expect(claim.body).toMatchObject({ status: "claimed", consent: false, suppressed: true });
  });
});
