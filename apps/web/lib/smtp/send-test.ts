import "server-only";
import { isInternalSmtpHost, isPrivateIp, type SmtpDelivery } from "@fusion-leap/domain";
import { lookup } from "node:dns/promises";
import nodemailer from "nodemailer";

export type SmtpTestCode = "blocked_host" | "auth_failed" | "connection_failed" | "timeout" | "rejected" | "failed";
export type SmtpTestResult = { ok: true } | { ok: false; code: SmtpTestCode };

type Options = {
  delivery: SmtpDelivery;
  /** Mot de passe déchiffré (jamais journalisé), ou `undefined` si la configuration n'en a pas. */
  password: string | undefined;
  /** Destinataire du message de test : l'adresse de l'administrateur connecté, jamais une saisie libre. */
  to: string;
  /** En développement et en test, les hôtes locaux sont autorisés (ex. boîte de test sur 127.0.0.1). */
  allowInternalHosts: boolean;
  timeoutMs?: number;
};

const TIMEOUT_MS = 10_000;

/** Traduit une erreur nodemailer en code : jamais son message (il peut contenir l'hôte, l'utilisateur ou la réponse du serveur). */
function codeOf(error: unknown): SmtpTestCode {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code === "EAUTH") return "auth_failed";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return "timeout";
  if (code === "ECONNECTION" || code === "ESOCKET" || code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EDNS" || code === "ECONNRESET") return "connection_failed";
  if (code === "EENVELOPE" || code === "EMESSAGE") return "rejected";
  return "failed";
}

/**
 * Envoie un message de test avec la configuration SMTP de la plateforme. Garde-fous : hôte interne refusé hors
 * développement (avant ET après résolution DNS : on se connecte à l'adresse résolue et contrôlée, pas au nom, pour
 * éviter le rebinding DNS) ; délais courts ; un seul destinataire (l'administrateur) ; aucun détail d'erreur renvoyé.
 */
export async function sendSmtpTest(options: Options): Promise<SmtpTestResult> {
  const { delivery } = options;
  const timeout = options.timeoutMs ?? TIMEOUT_MS;
  try {
    if (!options.allowInternalHosts && isInternalSmtpHost(delivery.host)) return { ok: false, code: "blocked_host" };

    let connectHost = delivery.host;
    if (!options.allowInternalHosts) {
      const addresses = await lookup(delivery.host, { all: true });
      if (addresses.length === 0 || addresses.some((a) => isPrivateIp(a.address))) return { ok: false, code: "blocked_host" };
      connectHost = addresses[0]!.address;
    }

    const transporter = nodemailer.createTransport({
      host: connectHost,
      port: delivery.port,
      secure: delivery.security === "tls",
      requireTLS: delivery.security === "starttls",
      ignoreTLS: delivery.security === "none",
      tls: { servername: delivery.host },
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout,
      ...(delivery.username ? { auth: { user: delivery.username, pass: options.password ?? "" } } : {}),
    });

    await transporter.sendMail({
      from: delivery.from_name ? { name: delivery.from_name, address: delivery.from_email } : delivery.from_email,
      to: options.to,
      subject: "Fusion Leap AI Growth : test de la configuration SMTP",
      text: "Ce message confirme que la configuration SMTP de la plateforme fonctionne.",
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, code: codeOf(error) };
  }
}
