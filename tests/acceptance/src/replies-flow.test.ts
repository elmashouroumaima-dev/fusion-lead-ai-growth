import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKeyRing, type EmailProvider, type EmailSendInput, type WhatsAppSender } from "../../../packages/adapters/src";
import { createSendMessageHandler } from "../../../apps/worker/src/handlers";
import type { SendClaim, SendGateway } from "../../../apps/worker/src/send";
import { api, ORG, psql, USER } from "../../../supabase/tests/rls/src/harness";
import { getPage, postJson, signIn, visibleText, type Session } from "./app-client";

/**
 * Réponses et verrou (J38) de bout en bout : la VRAIE route HTTP `POST /api/conversations/:id/replies` (sessions réelles), les VRAIES
 * fonctions SQL (`conversation_reply`, bail, `message_send_claim`) et le VRAI handler `send_message` du worker avec un FOURNISSEUR
 * D'E-MAIL DE TEST (aucun envoi réel). Scénarios : rôles (commercial assigné seulement, owner et admin partout, marketing et analyste 403,
 * autre entreprise 404), Idempotency-Key obligatoire et rejeu sans second message, la réponse est ENVOYÉE PAR LE WORKER (statut « accepté »,
 * une seule fois), do_not_contact respecté par le contrôle final, aucun message de l'IA et d'un humain en même temps (bail, reprise de main).
 * Les données de test portent un préfixe unique et sont supprimées à la fin.
 */
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TAG = `rpl${run}`;
const sessions = new Map<string, Session>();
const as = (who: string): Session => {
  const session = sessions.get(who);
  if (!session) throw new Error(`session absente : ${who}`);
  return session;
};
const ids: Record<string, string> = {};
let counter = 0;
const reply = (who: string | null, conversation: string, payload: unknown, opts: { key?: string | null; org?: string } = {}) =>
  postJson(who ? as(who) : null, `/api/conversations/${conversation}/replies`, payload, {
    activeOrg: opts.org ?? ORG.alpha,
    headers: opts.key === null ? {} : { "idempotency-key": opts.key ?? `${TAG}-${(counter += 1)}-${randomUUID()}` },
  });

/** Passerelle du worker pour le test : mêmes fonctions SQL que `createSupabaseSendGateway`, rôle service_role. */
const rpc = async <T>(name: string, body: Record<string, unknown>): Promise<T> => {
  const result = await api<T>("service", "POST", `rpc/${name}`, body);
  if (result.status >= 300) throw new Error(`${name}_failed`);
  return result.body;
};
type RawClaim = {
  status: string;
  message?: { body: string; approved: boolean; purpose: string | null; approver_valid: boolean; approval_age_seconds: number | null; recipient_unchanged: boolean };
  contact?: { email: string | null; phone?: string | null; do_not_contact: boolean };
  window_open?: boolean;
  template?: { status: string; name: string; language: string; category: string; version: number; variables: string[] } | null;
  channel?: { type: string; status: string; send_paused: boolean; sender: string; integration_id: string; integration_status: string | null; account?: string | null };
  organization_active?: boolean;
  organization_send_paused?: boolean;
  consent?: boolean;
  suppressed?: boolean;
  sent_last_hour?: number;
};
const gateway: SendGateway = {
  async claim(org, message): Promise<SendClaim> {
    const raw = await rpc<RawClaim>("message_send_claim", { p_org: org, p_message: message });
    if (raw.status !== "claimed" || !raw.message || !raw.contact || !raw.channel) return { status: raw.status } as SendClaim;
    return {
      status: "claimed",
      message: {
        body: raw.message.body, approved: raw.message.approved, purpose: raw.message.purpose, approverValid: raw.message.approver_valid,
        approvalAgeSeconds: raw.message.approval_age_seconds, recipientUnchanged: raw.message.recipient_unchanged,
      },
      contact: { email: raw.contact.email, phone: raw.contact.phone ?? null, doNotContact: raw.contact.do_not_contact },
      windowOpen: raw.window_open === true,
      template: raw.template ?? null,
      channel: {
        type: raw.channel.type, status: raw.channel.status, sendPaused: raw.channel.send_paused, sender: raw.channel.sender,
        integrationId: raw.channel.integration_id, integrationStatus: raw.channel.integration_status ?? "unknown", account: raw.channel.account ?? null,
      },
      organizationActive: raw.organization_active === true,
      organizationSendPaused: raw.organization_send_paused === true,
      consent: raw.consent === true,
      suppressed: raw.suppressed === true,
      sentLastHour: raw.sent_last_hour ?? 0,
    };
  },
  async markAccepted(org, message, providerMessageId) {
    await rpc("message_mark_accepted", { p_org: org, p_message: message, p_provider_message_id: providerMessageId });
  },
  async markFailed(org, message, code) {
    await rpc("message_mark_failed", { p_org: org, p_message: message, p_code: code });
  },
  async releaseClaim(org, message) {
    await rpc("message_release_claim", { p_org: org, p_message: message });
  },
};
const sent: EmailSendInput[] = [];
const provider: EmailProvider = {
  name: "test",
  async send(input) {
    sent.push(input);
    return { kind: "accepted", providerMessageId: `pm-${TAG}-${sent.length}` };
  },
};
// la réponse est e-mail seulement (J38) : l'expéditeur WhatsApp ne doit jamais être appelé
const unusedWhatsApp: WhatsAppSender = {
  name: "test-whatsapp-unused",
  async send() {
    throw new Error("whatsapp_must_not_be_called");
  },
};
const sendHandler = createSendMessageHandler({
  gateway, readSecret: async () => "jeton-de-test", provider, whatsapp: unusedWhatsApp,
  unsubscribe: { keyRing: createKeyRing(1, { 1: Buffer.alloc(32, 7).toString("base64") }), siteUrl: "http://localhost:3000" },
});
const runWorker = (message: string) =>
  sendHandler.run({ jobId: randomUUID(), organizationId: ORG.alpha, idempotencyKey: `send-message:${message}`, attempt: 1, maxAttempts: 5, signal: new AbortController().signal }, { message_id: message });
const statusOf = (message: string) => psql(`select status from public.messages where id = '${message}'`);

function seed() {
  psql(`
    insert into public.integrations (organization_id, provider, status, external_account_id) values ('${ORG.alpha}', 'email', 'active', '${TAG}-mail');
    insert into public.channels (organization_id, type, integration_id, sender_identity, status)
      select '${ORG.alpha}', 'email', id, 'ventes@${TAG}.test', 'active' from public.integrations where external_account_id = '${TAG}-mail';
    insert into public.contacts (organization_id, name, email_raw, email_normalized) values
      ('${ORG.alpha}', 'Zz${TAG} Nadia', 'nadia.${TAG}@rpl.test', 'nadia.${TAG}@rpl.test'),
      ('${ORG.alpha}', 'Zz${TAG} Karim', 'karim.${TAG}@rpl.test', 'karim.${TAG}@rpl.test'),
      ('${ORG.alpha}', 'Zz${TAG} Salma', 'salma.${TAG}@rpl.test', 'salma.${TAG}@rpl.test');
  `);
  const channel = psql(`select ch.id from public.channels ch join public.integrations i on i.id = ch.integration_id where i.external_account_id = '${TAG}-mail'`);
  for (const label of ["Nadia", "Karim", "Salma"]) {
    const contact = psql(`select id from public.contacts where name = 'Zz${TAG} ${label}'`);
    ids[label] = psql(`select (private.conversation_get_or_create('${ORG.alpha}', '${contact}', '${channel}') ->> 'id')`);
    ids[`${label}Contact`] = contact;
    // le contact a écrit en premier : le consentement conversationnel (30 jours) couvre la réponse
    psql(`select private.message_record('${ORG.alpha}', '${ids[label]}', 'inbound', '${TAG}.${label}', 'Bonjour, une question.', null, now() - interval '1 hour')`);
  }
  psql(`update public.conversations set assignee_id = '${USER.alphaSales}', state = 'open' where id in ('${ids.Nadia}', '${ids.Karim}')`);
}

const cleanup = () =>
  psql(`
    set session_replication_role = replica;
    delete from public.jobs where payload ->> 'message_id' in (select id::text from public.messages where conversation_id in (select id from public.conversations where contact_id in (select id from public.contacts where name like '%${TAG}%')));
    delete from public.messages where conversation_id in (select id from public.conversations where contact_id in (select id from public.contacts where name like '%${TAG}%'));
    delete from public.conversations where contact_id in (select id from public.contacts where name like '%${TAG}%');
    delete from public.channels where integration_id in (select id from public.integrations where external_account_id like '${TAG}-%');
    delete from public.integrations where external_account_id like '${TAG}-%';
    delete from public.contacts where name like '%${TAG}%';
  `);

/**
 * Un worker de développement peut tourner sur la même base et prendre les jobs de ce test (sans identifiants réels, le message passerait
 * « en échec » avant notre passage). Un déclencheur temporaire repousse d'une heure les seuls jobs `send_message` des messages de CE test :
 * le worker du test les exécute lui-même, de façon déterministe. Supprimé à la fin.
 */
const holdJobs = () =>
  psql(`
    create or replace function public.zz_hold_${TAG}() returns trigger language plpgsql as $f$
    begin
      if new.kind = 'send_message' and exists (
        select 1 from public.messages m join public.conversations c on c.id = m.conversation_id join public.contacts k on k.id = c.contact_id
         where m.id::text = new.payload ->> 'message_id' and k.name like '%${TAG}%') then
        new.next_run_at := now() + interval '1 hour';
      end if;
      return new;
    end $f$;
    create trigger zz_hold_${TAG} before insert on public.jobs for each row execute function public.zz_hold_${TAG}();
  `);
const releaseJobs = () =>
  psql(`
    drop trigger if exists zz_hold_${TAG} on public.jobs;
    drop function if exists public.zz_hold_${TAG}();
  `);

beforeAll(async () => {
  cleanup();
  for (const who of ["shared", "alpha-admin", "alpha-marketing", "alpha-sales", "alpha-analyst", "beta-owner"]) sessions.set(who, await signIn(`${who}@seed.test`));
  seed();
  holdJobs();
});
afterAll(() => {
  releaseJobs();
  cleanup();
});

describe("POST /api/conversations/:id/replies : rôles, clé d'idempotence, validation", () => {
  it("sans session : 401 ; marketing et analyste : 403 ; autre entreprise : introuvable", async () => {
    expect((await reply(null, ids.Nadia as string, { body: "Bonjour" })).status).toBe(401);
    for (const who of ["alpha-marketing", "alpha-analyst"]) expect((await reply(who, ids.Nadia as string, { body: "Bonjour" })).status, who).toBe(403);
    expect((await reply("beta-owner", ids.Nadia as string, { body: "Bonjour" }, { org: ORG.beta })).status).toBe(404);
    expect(psql(`select count(*) from public.messages where conversation_id = '${ids.Nadia}' and direction = 'outbound'`)).toBe("0");
  });

  it("le commercial ne répond qu'à SES conversations : une autre est introuvable (404), aucun message créé", async () => {
    const res = await reply("alpha-sales", ids.Salma as string, { body: "Bonjour" });
    expect(res.status).toBe(404);
    expect(psql(`select count(*) from public.messages where conversation_id = '${ids.Salma}' and direction = 'outbound'`)).toBe("0");
  });

  it("Idempotency-Key obligatoire ; identifiant invalide : 404 ; corps vide, trop long, champ en plus (organization_id) : 400", async () => {
    expect((await reply("alpha-sales", ids.Nadia as string, { body: "Bonjour" }, { key: null })).status).toBe(400);
    expect((await reply("alpha-sales", "pas-un-uuid", { body: "Bonjour" })).status).toBe(404);
    expect((await reply("alpha-sales", ids.Nadia as string, { body: "" })).status).toBe(400);
    expect((await reply("alpha-sales", ids.Nadia as string, { body: "x".repeat(10_001) })).status).toBe(400);
    expect((await reply("alpha-sales", ids.Nadia as string, { body: "Bonjour", organization_id: ORG.beta })).status).toBe(400);
    expect(psql(`select count(*) from public.messages where conversation_id = '${ids.Nadia}' and direction = 'outbound'`)).toBe("0");
  });
});

describe("réponse du commercial assigné : mise en file puis ENVOI PAR LE WORKER", () => {
  const key = `${TAG}-replay-key-0001`;
  let messageId = "";

  it("202 { message_id, status: queued } ; le message est approuvé par son auteur, un job est en file, le rejeu ne crée pas de second message", async () => {
    const first = await reply("alpha-sales", ids.Nadia as string, { body: "Bonjour Nadia, voici notre offre." }, { key });
    expect(first.status).toBe(202);
    expect(first.json.status).toBe("queued");
    messageId = String(first.json.message_id);
    expect(messageId).toMatch(/^[0-9a-f-]{36}$/);
    const row = psql(`select status || '|' || approved_by || '|' || approved_purpose || '|' || approved_recipient from public.messages where id = '${messageId}'`);
    expect(row).toBe(`queued|${USER.alphaSales}|reply|nadia.${TAG}@rpl.test`);
    expect(psql(`select count(*) from public.jobs where kind = 'send_message' and payload ->> 'message_id' = '${messageId}'`)).toBe("1");
    const replay = await reply("alpha-sales", ids.Nadia as string, { body: "Bonjour Nadia, voici notre offre." }, { key });
    expect(replay.status).toBe(202);
    expect(String(replay.json.message_id)).toBe(messageId);
    expect(psql(`select count(*) from public.messages where conversation_id = '${ids.Nadia}' and direction = 'outbound'`)).toBe("1");
    // même clé, autre corps : refusée
    const other = await reply("alpha-sales", ids.Nadia as string, { body: "Un autre texte" }, { key });
    expect(other.status).toBeGreaterThanOrEqual(400);
    expect(psql(`select count(*) from public.messages where conversation_id = '${ids.Nadia}' and direction = 'outbound'`)).toBe("1");
  });

  it("l'audit ne contient jamais le corps du message", () => {
    const audit = psql(`select count(*) from public.audit_logs where (coalesce(before::text, '') || coalesce(after::text, '')) like '%voici notre offre%'`);
    expect(audit).toBe("0");
  });

  it("le WORKER envoie : statut « accepté », un seul appel au fournisseur (bonne adresse, bon expéditeur, bon texte) ; un second passage ne renvoie rien", async () => {
    expect(statusOf(messageId)).toBe("queued");
    await runWorker(messageId);
    expect(statusOf(messageId)).toBe("accepted");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(`nadia.${TAG}@rpl.test`);
    expect(sent[0]?.from).toBe(`ventes@${TAG}.test`);
    // chaque e-mail porte le pied de page de désabonnement (J33) : le texte de la réponse reste en tête, inchangé
    expect(sent[0]?.textBody.startsWith("Bonjour Nadia, voici notre offre.")).toBe(true);
    await runWorker(messageId);
    expect(sent).toHaveLength(1);
  });

  it("owner et admin répondent aussi à une conversation assignée à un autre", async () => {
    for (const who of ["shared", "alpha-admin"]) {
      const res = await reply(who, ids.Karim as string, { body: `Réponse de ${who}` });
      expect(res.status, who).toBe(202);
      await runWorker(String(res.json.message_id));
      expect(statusOf(String(res.json.message_id)), who).toBe("accepted");
    }
  });
});

describe("contrôle final du worker : do_not_contact", () => {
  it("la réponse est mise en file mais le worker REFUSE l'envoi pour un contact « ne pas contacter » : message en échec, fournisseur non appelé", async () => {
    psql(`update public.contacts set do_not_contact = true where id = '${ids.KarimContact}'`);
    const before = sent.length;
    const res = await reply("alpha-admin", ids.Karim as string, { body: "Message qui ne doit pas partir" });
    expect(res.status).toBe(202);
    const id = String(res.json.message_id);
    await runWorker(id);
    expect(statusOf(id)).toBe("failed");
    expect(sent).toHaveLength(before);
    psql(`update public.contacts set do_not_contact = false where id = '${ids.KarimContact}'`);
  });
});

describe("verrou : jamais une réponse de l'IA et d'un humain en même temps", () => {
  const lockAs = (persona: "alphaAdmin" | "alphaSales" | "shared", fn: string) => api<Record<string, unknown>>(persona, "POST", `rpc/${fn}`, { p_org: ORG.alpha, p_conversation: ids.Nadia });
  const ai = (fn: "conversation_ai_claim" | "conversation_ai_release") => api<Record<string, unknown>>("service", "POST", `rpc/${fn}`, { p_org: ORG.alpha, p_conversation: ids.Nadia });

  it("tant qu'un humain tient le bail, un autre membre ne peut pas répondre (409) et l'IA ne peut pas prendre la conversation", async () => {
    expect((await lockAs("alphaAdmin", "conversation_lock_acquire")).body.status).toBe("acquired");
    const blocked = await reply("alpha-sales", ids.Nadia as string, { body: "Je réponds aussi" });
    expect(blocked.status).toBe(409);
    expect((await ai("conversation_ai_claim")).body.status).toBe("busy");
    // le titulaire du bail peut répondre ; sa réponse libère le bail
    const mine = await reply("alpha-admin", ids.Nadia as string, { body: "Réponse du titulaire du bail" });
    expect(mine.status).toBe(202);
    await runWorker(String(mine.json.message_id));
  });

  it("quand l'IA tient la conversation, aucun humain ne répond (409) ; « reprendre la main » rend la réponse possible", async () => {
    expect((await ai("conversation_ai_claim")).body.status).toBe("claimed");
    const blocked = await reply("alpha-sales", ids.Nadia as string, { body: "Réponse humaine pendant l'IA" });
    expect(blocked.status).toBe(409);
    expect(String((await lockAs("alphaSales", "conversation_take_over")).status)).toMatch(/^2/);
    const ok = await reply("alpha-sales", ids.Nadia as string, { body: "Je reprends la main" });
    expect(ok.status).toBe(202);
    await runWorker(String(ok.json.message_id));
    expect(statusOf(String(ok.json.message_id))).toBe("accepted");
    expect(psql(`select handled_by from public.conversations where id = '${ids.Nadia}'`)).toBe("human");
  });
});

describe("fil : le composeur n'apparaît que pour ceux qui peuvent répondre", () => {
  it("le commercial assigné et l'admin voient le composeur ; le commercial voit un fil d'un autre comme introuvable ; marketing est renvoyé au tableau de bord", async () => {
    for (const who of ["alpha-sales", "alpha-admin"]) {
      const res = await getPage(as(who), `/fr/inbox/${ids.Nadia}`, ORG.alpha);
      expect(res.status, who).toBe(200);
      expect(res.body, who).toContain('name="body"');
      expect(visibleText(res), who).toContain("Envoyer la réponse");
    }
    expect((await getPage(as("alpha-sales"), `/fr/inbox/${ids.Salma}`, ORG.alpha)).status).toBe(404);
    const marketing = await getPage(as("alpha-marketing"), `/fr/inbox/${ids.Nadia}`, ORG.alpha);
    expect(marketing.status).toBeGreaterThanOrEqual(300);
    expect(marketing.status).toBeLessThan(400);
  });
});
