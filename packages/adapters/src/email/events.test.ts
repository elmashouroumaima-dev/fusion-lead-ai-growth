import { describe, expect, it } from "vitest";
import { EMAIL_BODY_MAX, normalizePostmarkPayload, readEmailEvent, type EmailEvent } from "./events";

/** Exemples de la documentation officielle de Postmark (pages « Delivery webhook », « Bounce webhook », « Spam complaint webhook », « Parse an email »). */
const DELIVERY = {
  RecordType: "Delivery", MessageStream: "outbound", ServerID: 23, MessageID: "883953f4-6105-42a2-a16a-77a8eac79483",
  Recipient: "margareth@nasa.com", Tag: "welcome-email", DeliveredAt: "2026-11-05T16:33:54.9070259Z",
  Details: "250 2.0.0 OK  1762360434 x12-20020a05 - gsmtp", Metadata: { PropA: "some value", PropB: "some value" },
};
const BOUNCE = {
  RecordType: "Bounce", MessageStream: "outbound", ID: 692560173, Type: "HardBounce", TypeCode: 1, Name: "Hard bounce", Tag: "Test",
  MessageID: "883953f4-6105-42a2-a16a-77a8eac79483", Metadata: { PropA: "some value", PropB: "some value" }, ServerID: 23,
  Description: "The server was unable to deliver your message (ex: unknown user, mailbox not found).", Details: "Test bounce details",
  Email: "margareth@nasa.com", From: "alanturing@computers.com", BouncedAt: "2026-11-05T16:33:54.9070259Z", DumpAvailable: true, Inactive: true,
  CanActivate: true, Subject: "Saying Hello!", Content: "<Full dump of bounce>",
};
const COMPLAINT = {
  RecordType: "SpamComplaint", MessageStream: "outbound", ID: 692560174, Type: "SpamComplaint", TypeCode: 100001, Name: "Spam complaint", Tag: "welcome-email",
  MessageID: "883953f4-6105-42a2-a16a-77a8eac79483", Metadata: { PropA: "some value", PropB: "some value" }, ServerID: 23,
  Description: "The subscriber explicitly marked this message as spam.", Details: "Test spam complaint details", Email: "margareth@nasa.com",
  From: "alanturing@computers.com", BouncedAt: "2026-11-05T16:33:54.9070259Z", DumpAvailable: true, Inactive: true, CanActivate: false, Subject: "Saying Hello!",
  Content: "<Abuse report dump>",
};
const INBOUND = {
  From: "myUser@theirDomain.com", MessageStream: "inbound", FromName: "My User",
  FromFull: { Email: "myUser@theirDomain.com", Name: "John Doe", MailboxHash: "" },
  To: "451d9b70cf9364d23ff6f9d51d870251569e+ahoy@inbound.postmarkapp.com",
  ToFull: [{ Email: "451d9b70cf9364d23ff6f9d51d870251569e+ahoy@inbound.postmarkapp.com", Name: "", MailboxHash: "ahoy" }],
  OriginalRecipient: "451d9b70cf9364d23ff6f9d51d870251569e+ahoy@inbound.postmarkapp.com", ReplyTo: "myUsersReplyAddress@theirDomain.com",
  Subject: "This is an inbound message", MessageID: "22c74902-a0c1-4511-804f-341342852c90", Date: "Thu, 5 Apr 2012 16:59:01 +0200", MailboxHash: "ahoy",
  TextBody: "[ASCII]", HtmlBody: "[HTML]", StrippedTextReply: "Ok, thanks for letting me know!", Tag: "",
  Headers: [
    { Name: "X-Spam-Status", Value: "No" },
    { Name: "X-Spam-Score", Value: "-0.1" },
    { Name: "Received-SPF", Value: "Pass (sender SPF authorized) identity=mailfrom; client-ip=209.85.160.180; helo=mail-gy0-f180.google.com; envelope-from=myUser@theirDomain.com; receiver=451d9b70cf9364d23ff6f9d51d870251569e@inbound.postmarkapp.com" },
    { Name: "Message-ID", Value: "<CAGXpo2WKfxHWZ5UFYCR3H_J9SNMG+5AXUovfEFL6DjWBJSyZaA@mail.gmail.com>" },
  ],
  Attachments: [{ Name: "myimage.png", Content: "[BASE64-ENCODED CONTENT]", ContentType: "image/png", ContentLength: 4096, ContentID: "myimage.png@01CE7342.75E71F80" }],
};

const REF = "9d2a6f4e-1b3c-4d5e-8f70-a1b2c3d4e5f6";
const parse = (payload: unknown): EmailEvent => {
  const event = normalizePostmarkPayload(payload);
  expect(event).not.toBeNull();
  return event as EmailEvent;
};

describe("normalizePostmarkPayload : exemples officiels", () => {
  it("Delivery : delivered, destinataire normalisé, identifiant composé", () => {
    const event = parse(DELIVERY);
    expect(event).toMatchObject({ kind: "delivered", providerMessageId: "883953f4-6105-42a2-a16a-77a8eac79483", recipient: "margareth@nasa.com", at: "2026-11-05T16:33:54.907Z", ref: null });
    expect(event.eventId).toMatch(/^delivery:883953f4-6105-42a2-a16a-77a8eac79483:[0-9a-f]{16}$/);
  });

  it("Delivery : deux destinataires du même message donnent deux identifiants", () => {
    expect(parse(DELIVERY).eventId).not.toBe(parse({ ...DELIVERY, Recipient: "autre@nasa.com" }).eventId);
    expect(parse(DELIVERY).eventId).toBe(parse({ ...DELIVERY }).eventId);
  });

  it("l'identifiant de NOTRE message revient par les métadonnées, seulement s'il est un UUID", () => {
    expect(parse({ ...DELIVERY, Metadata: { fusion_message_id: REF } })).toMatchObject({ ref: REF });
    expect(parse({ ...DELIVERY, Metadata: { fusion_message_id: "pas-un-uuid" } })).toMatchObject({ ref: null });
    expect(parse({ ...DELIVERY, Metadata: "x" })).toMatchObject({ ref: null });
  });

  it("Bounce : dur seulement si TypeCode vaut 1 ; l'identifiant est celui du rebond", () => {
    expect(parse(BOUNCE)).toMatchObject({ kind: "bounced", hard: true, eventId: "bounce:692560173", recipient: "margareth@nasa.com" });
    expect(parse({ ...BOUNCE, TypeCode: 4096, Type: "SoftBounce" })).toMatchObject({ hard: false });
    expect(parse({ ...BOUNCE, TypeCode: 2, Type: "Transient" })).toMatchObject({ hard: false });
    expect(parse({ ...BOUNCE, TypeCode: "1" })).toMatchObject({ hard: false });
  });

  it("SpamComplaint : complaint", () => {
    expect(parse(COMPLAINT)).toMatchObject({ kind: "complaint", eventId: "complaint:692560174", recipient: "margareth@nasa.com" });
  });

  it("aucun vidage de rebond, d'abus ou détail n'est conservé", () => {
    for (const payload of [BOUNCE, COMPLAINT, DELIVERY]) {
      const text = JSON.stringify(parse(payload));
      expect(text).not.toContain("dump");
      expect(text).not.toContain("Test bounce details");
      expect(text).not.toContain("gsmtp");
      expect(text).not.toContain("alanturing");
    }
  });

  it("Inbound : expéditeur et destinataire normalisés, SPF aligné, pas de pièces jointes ni de HTML", () => {
    const event = parse(INBOUND);
    expect(event).toMatchObject({
      kind: "inbound", eventId: "inbound:22c74902-a0c1-4511-804f-341342852c90", from: "myuser@theirdomain.com", subject: "This is an inbound message",
      body: "[ASCII]", spfPass: true, spam: false, at: "2012-04-05T14:59:01.000Z",
    });
    expect((event as Extract<EmailEvent, { kind: "inbound" }>).recipients).toEqual(["451d9b70cf9364d23ff6f9d51d870251569e+ahoy@inbound.postmarkapp.com"]);
    const text = JSON.stringify(event);
    expect(text).not.toContain("BASE64");
    expect(text).not.toContain("[HTML]");
    expect(text).not.toContain("myimage");
  });

  it("Inbound : SPF qui n'est pas « Pass » ou en-tête absent = non authentifié ; spam signalé", () => {
    const withHeaders = (headers: unknown) => parse({ ...INBOUND, Headers: headers }) as Extract<EmailEvent, { kind: "inbound" }>;
    expect(withHeaders([{ Name: "Received-SPF", Value: "Fail (domain does not designate)" }]).spfPass).toBe(false);
    expect(withHeaders([{ Name: "Received-SPF", Value: "SoftFail" }]).spfPass).toBe(false);
    expect(withHeaders([]).spfPass).toBe(false);
    expect(withHeaders(undefined).spfPass).toBe(false);
    expect(withHeaders([{ Name: "x-spam-status", Value: "Yes, score=9" }]).spam).toBe(true);
    expect(withHeaders([{ Name: "RECEIVED-SPF", Value: "pass identity=mailfrom; envelope-from=myUser@theirDomain.com" }]).spfPass).toBe(true);
    expect(withHeaders([{ Name: "RECEIVED-SPF", Value: "pass" }]).spfPass).toBe(false);
  });

  it("USURPATION : un « Pass » SPF d'un AUTRE domaine que celui de l'adresse affichée ne suffit pas (alignement exigé)", () => {
    const withSpf = (value: string, from = "myUser@theirDomain.com") =>
      (parse({ ...INBOUND, From: from, FromFull: { Email: from }, Headers: [{ Name: "Received-SPF", Value: value }] }) as Extract<EmailEvent, { kind: "inbound" }>).spfPass;
    // l'attaquant passe SPF avec SON domaine et affiche l'adresse d'un contact
    expect(withSpf("Pass (ok) identity=mailfrom; envelope-from=attaquant@attacker.test", "contact@victime.test")).toBe(false);
    expect(withSpf("Pass (ok) identity=mailfrom; envelope-from=contact@victime.test", "contact@victime.test")).toBe(true);
    // sous-domaine de la même organisation (expéditeur transactionnel) : accepté
    expect(withSpf("Pass (ok) identity=mailfrom; envelope-from=bounce@mail.victime.test", "contact@victime.test")).toBe(true);
    expect(withSpf("Pass (ok) identity=mailfrom; envelope-from=contact@victime.test", "contact@news.victime.test")).toBe(true);
    // un domaine qui finit pareil sans être un sous-domaine n'est PAS aligné
    expect(withSpf("Pass (ok) identity=mailfrom; envelope-from=x@evilvictime.test", "contact@victime.test")).toBe(false);
    expect(withSpf("Pass (ok) smtp.mailfrom=contact@victime.test", "contact@victime.test")).toBe(true);
    expect(withSpf("Pass (ok) identity=mailfrom; envelope-from=<contact@victime.test>;", "contact@victime.test")).toBe(true);
    expect(withSpf("Pass (ok) identity=helo; helo=victime.test", "contact@victime.test")).toBe(false);
  });

  it("USURPATION : un en-tête de même nom en double (celui de l'expéditeur) rend l'authentification non fiable", () => {
    const real = { Name: "Received-SPF", Value: "Pass (ok) identity=mailfrom; envelope-from=myUser@theirDomain.com" };
    const forged = { Name: "Received-SPF", Value: "Pass (forgé) identity=mailfrom; envelope-from=myUser@theirDomain.com" };
    const inboundWith = (headers: unknown[]) => (parse({ ...INBOUND, Headers: headers }) as Extract<EmailEvent, { kind: "inbound" }>).spfPass;
    expect(inboundWith([real])).toBe(true);
    expect(inboundWith([forged, real])).toBe(false);
    expect(inboundWith([real, forged])).toBe(false);
  });

  it("DKIM valide du domaine de l'auteur (DKIM_VALID_AU, un seul en-tête) authentifie aussi ; en double ou sans cette preuve : non", () => {
    const tests = (...values: string[]) => (parse({ ...INBOUND, Headers: values.map((Value) => ({ Name: "X-Spam-Tests", Value })) }) as Extract<EmailEvent, { kind: "inbound" }>).spfPass;
    expect(tests("DKIM_SIGNED,DKIM_VALID,DKIM_VALID_AU,SPF_PASS")).toBe(true);
    expect(tests("DKIM_SIGNED,DKIM_VALID,SPF_PASS")).toBe(false);
    expect(tests("DKIM_VALID_AU", "DKIM_VALID_AU")).toBe(false);
    expect(tests("NOT_DKIM_VALID_AU")).toBe(false);
  });

  it("spam : un en-tête « Yes » parmi plusieurs suffit", () => {
    const spam = (...values: string[]) => (parse({ ...INBOUND, Headers: values.map((Value) => ({ Name: "X-Spam-Status", Value })) }) as Extract<EmailEvent, { kind: "inbound" }>).spam;
    expect(spam("No", "Yes, score=7")).toBe(true);
    expect(spam("No")).toBe(false);
  });

  it("destinataire : OriginalRecipient seul quand il existe (l'en-tête « To » de l'expéditeur ne choisit pas le canal) ; sinon « To » sans variantes", () => {
    const recipients = (patch: Record<string, unknown>) => (parse({ ...INBOUND, ...patch }) as Extract<EmailEvent, { kind: "inbound" }>).recipients;
    expect(recipients({ OriginalRecipient: "Ventes@Acme.test", ToFull: [{ Email: "autre@acme.test" }] })).toEqual(["ventes@acme.test"]);
    expect(recipients({ OriginalRecipient: undefined, ToFull: [{ Email: "a@acme.test" }, { Email: "b+tag@acme.test" }] })).toEqual(["a@acme.test", "b+tag@acme.test"]);
    expect(recipients({ OriginalRecipient: "", ToFull: [] })).toEqual([]);
  });

  it("texte : NUL retirés, surrogates isolés remplacés, coupure par point de code (jamais au milieu d'une paire) ; jamais un corps que la base refuserait", () => {
    const inbound = (patch: Record<string, unknown>) => parse({ ...INBOUND, ...patch }) as Extract<EmailEvent, { kind: "inbound" }>;
    expect(inbound({ TextBody: "avant\u0000après" }).body).toBe("avantaprès");
    expect(inbound({ TextBody: "a\ud800b" }).body).toBe("a\ufffdb");
    expect(inbound({ TextBody: "a\udc00b" }).body).toBe("a\ufffdb");
    const emoji = "\u{1F600}";
    const cut = inbound({ TextBody: emoji.repeat(EMAIL_BODY_MAX + 5) }).body;
    expect(Array.from(cut)).toHaveLength(EMAIL_BODY_MAX);
    expect(cut.endsWith(emoji)).toBe(true);
    expect(JSON.stringify(inbound({ Subject: "obj\u0000et\ud800" }))).not.toContain("\\u0000");
    expect(inbound({ Subject: "obj\u0000et" }).subject).toBe("objet");
  });

  it("identifiant d'événement : toujours conforme à la contrainte de la base (haché quand l'identifiant du fournisseur ne l'est pas)", () => {
    const EVENT_ID = /^[A-Za-z0-9._:=+/@-]{1,200}$/;
    for (const id of ["<abc@mail.example>", "a$b%c", "x".repeat(900), "uuid-normal-1234"]) {
      expect(parse({ ...INBOUND, MessageID: id }).eventId, id).toMatch(EVENT_ID);
      expect(parse({ ...DELIVERY, MessageID: id }).eventId, id).toMatch(EVENT_ID);
    }
    expect(parse({ ...INBOUND, MessageID: "uuid-normal-1234" }).eventId).toBe("inbound:uuid-normal-1234");
    expect(parse({ ...INBOUND, MessageID: "<abc@mail.example>" }).eventId).not.toBe(parse({ ...INBOUND, MessageID: "<abd@mail.example>" }).eventId);
  });

  it("rebond dur : HardBounce (1) et adresse invalide (100000) ; blocage du FAI, désactivation manuelle et rebond doux ne suppriment pas l'adresse", () => {
    for (const [code, hard] of [[1, true], [100000, true], [100006, false], [100002, false], [4096, false], [2, false]] as const) {
      expect(parse({ ...BOUNCE, TypeCode: code }), String(code)).toMatchObject({ hard });
    }
  });

  it("Inbound : corps = texte, sinon réponse extraite, sinon libellé ; 100 000 caractères au plus ; objet vide = null", () => {
    const inbound = (patch: Record<string, unknown>) => parse({ ...INBOUND, ...patch }) as Extract<EmailEvent, { kind: "inbound" }>;
    expect(inbound({ TextBody: "  \n " }).body).toBe("Ok, thanks for letting me know!");
    expect(inbound({ TextBody: "", StrippedTextReply: "" }).body).toBe("(message sans texte)");
    expect(inbound({ TextBody: "a".repeat(EMAIL_BODY_MAX + 500) }).body).toHaveLength(EMAIL_BODY_MAX);
    expect(inbound({ Subject: "   " }).subject).toBeNull();
    expect(inbound({ Subject: "s".repeat(900) }).subject).toHaveLength(300);
  });

  it("autre type d'événement (ouverture, clic) : acquitté puis ignoré", () => {
    expect(parse({ RecordType: "Open", MessageID: "x" })).toEqual({ kind: "ignored", eventId: "ignored:Open", recordType: "Open" });
    expect(parse({ RecordType: "SubscriptionChange" })).toMatchObject({ kind: "ignored" });
  });

  it("formes invalides : refusées (null)", () => {
    for (const bad of [
      null, "texte", 12, [], {}, { RecordType: "Delivery" },
      { ...DELIVERY, MessageID: "id avec espace" }, { ...DELIVERY, MessageID: undefined }, { ...DELIVERY, Recipient: "pas-une-adresse" }, { ...DELIVERY, DeliveredAt: undefined },
      { ...BOUNCE, ID: undefined }, { ...BOUNCE, ID: -3 }, { ...BOUNCE, ID: 1.5 }, { ...BOUNCE, Email: "x" },
      { ...COMPLAINT, MessageID: "" }, { RecordType: "Bad Type!" },
      { ...INBOUND, FromFull: { Email: "pas-une-adresse" } }, { ...INBOUND, FromFull: "x" }, { ...INBOUND, MessageID: "a b" },
    ]) {
      expect(normalizePostmarkPayload(bad)).toBeNull();
    }
  });
});

describe("readEmailEvent : relecture de la forme conservée", () => {
  it("relit chaque type normalisé à l'identique", () => {
    for (const payload of [DELIVERY, BOUNCE, COMPLAINT, INBOUND, { RecordType: "Click" }, { ...DELIVERY, Metadata: { fusion_message_id: REF } }]) {
      const event = parse(payload);
      expect(readEmailEvent(JSON.parse(JSON.stringify(event)))).toEqual(event);
    }
  });

  it("refuse une forme altérée", () => {
    const delivered = parse(DELIVERY) as Record<string, unknown>;
    const bounced = parse(BOUNCE) as Record<string, unknown>;
    const inbound = parse(INBOUND) as Record<string, unknown>;
    for (const bad of [
      null, "x", [], {}, { ...delivered, kind: "other" }, { ...delivered, eventId: "id invalide" }, { ...delivered, providerMessageId: "a b" }, { ...delivered, recipient: "x" },
      { ...delivered, at: "pas une date" }, { ...delivered, ref: "pas-un-uuid" }, { ...delivered, ref: undefined },
      { ...bounced, hard: "true" }, { ...bounced, hard: undefined },
      { ...inbound, body: "" }, { ...inbound, body: "x".repeat(EMAIL_BODY_MAX + 1) }, { ...inbound, recipients: [] }, { ...inbound, recipients: ["x"] },
      { ...inbound, recipients: Array.from({ length: 21 }, () => "a@b.test") }, { ...inbound, spfPass: "yes" }, { ...inbound, spam: undefined },
      { ...inbound, from: "x" }, { ...inbound, subject: 5 }, { ...inbound, subject: "s".repeat(301) },
      { kind: "ignored", eventId: "ignored:Open", recordType: "Bad Type!" },
    ]) {
      expect(readEmailEvent(bad)).toBeNull();
    }
  });
});
