import dns from "node:dns";
import nodemailer from "nodemailer";
import { logOtpFailure } from "./otpDiagnostics";

dns.setDefaultResultOrder("ipv4first");

type LocalMail = { email: string; subject: string; text: string; createdAt: number };
const localOutbox: LocalMail[] = [];
const LOCAL_CODE_TTL_MS = 10 * 60 * 1000;
const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
const SMTP_GREETING_TIMEOUT_MS = 10_000;
const SMTP_SOCKET_TIMEOUT_MS = 15_000;

export function smtpConfigured(): boolean {
  return Boolean(process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASSWORD && process.env.EMAIL_FROM);
}

export function getEmailConfigStatus(): { providerConfigured: boolean; senderConfigured: boolean; credentialsConfigured: boolean } {
  const port = Number(process.env.EMAIL_PORT || 587);
  return {
    providerConfigured: Boolean(process.env.EMAIL_HOST?.trim()) && Number.isInteger(port) && port > 0 && port <= 65535,
    senderConfigured: Boolean(process.env.EMAIL_FROM?.trim()),
    credentialsConfigured: Boolean(process.env.EMAIL_USER?.trim() && process.env.EMAIL_PASSWORD),
  };
}

function saveLocalMail(mail: LocalMail): void {
  localOutbox.push(mail);
  if (localOutbox.length > 100) localOutbox.shift();
}

export function getLocalVerificationCode(email: string): { subject: string; code: string } | undefined {
  const mail = [...localOutbox].reverse().find((item) =>
    item.email === email.trim().toLowerCase() &&
    item.subject === "Verify your FitOS account" &&
    Date.now() - item.createdAt < LOCAL_CODE_TTL_MS
  );
  const code = mail?.text.match(/(?:code is:|code:)\s*\n?\s*(\d{6})/i)?.[1];
  return mail && code ? { subject: mail.subject, code } : undefined;
}

export function getTransport() {
  const { EMAIL_HOST, EMAIL_USER, EMAIL_PASSWORD, EMAIL_FROM } = process.env;
  if (!EMAIL_HOST || !EMAIL_USER || !EMAIL_PASSWORD || !EMAIL_FROM) throw new Error("Transactional email is not configured");
  const port = Number(process.env.EMAIL_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("EMAIL_PORT must be a valid TCP port");
  return nodemailer.createTransport({
    host: EMAIL_HOST,
    port,
    secure: port === 465,
    requireTLS: port === 587,
    auth: { user: EMAIL_USER, pass: EMAIL_PASSWORD },
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
  });
}

function classifySmtpError(error: unknown): string {
  const smtpError = error as { code?: string; command?: string; responseCode?: number };
  const code = smtpError?.code || "";
  const command = (smtpError?.command || "").toUpperCase();
  if (["EDNS", "ENOTFOUND", "EAI_AGAIN"].includes(code)) return "SMTP DNS resolution failed";
  if (["ECONNECTION", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) return "SMTP TCP connection failed";
  if (command.includes("TLS") || command.includes("STARTTLS") || code.startsWith("ERR_TLS")) return "SMTP TLS/STARTTLS failed";
  if (command.includes("AUTH") || smtpError?.responseCode === 535 || smtpError?.responseCode === 534) return "SMTP authentication failed";
  return "SMTP message send failed";
}

async function withSmtpDeadline<T>(transport: ReturnType<typeof getTransport>, operation: Promise<T>, timeoutMs: number, operationName: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          transport.close();
          reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    transport.close();
  }
}

async function sendSmtpMail(mail: { from: string | undefined; to: string; subject: string; text: string }, flow: string): Promise<void> {
  const transport = getTransport();
  const timeoutMs = SMTP_CONNECTION_TIMEOUT_MS + SMTP_GREETING_TIMEOUT_MS + SMTP_SOCKET_TIMEOUT_MS + 1_000;
  try {
    await withSmtpDeadline(transport, transport.sendMail(mail), timeoutMs, "SMTP message send");
  } catch (error) {
    console.error(`[EMAIL] ${classifySmtpError(error)}`);
    logOtpFailure(`smtp_message_send_${flow}`, "nodemailer-smtp", error);
    throw error;
  }
}

async function verifySmtpTransport(): Promise<void> {
  const transport = getTransport();
  try {
    await withSmtpDeadline(transport, transport.verify(), SMTP_CONNECTION_TIMEOUT_MS + SMTP_GREETING_TIMEOUT_MS + 1_000, "SMTP transport verification");
    console.info("[EMAIL] SMTP transport verification: OK");
  } catch (error) {
    console.error("[EMAIL] SMTP transport verification: FAILED");
    console.error(`[EMAIL] ${classifySmtpError(error)}`);
    logOtpFailure("smtp_transport_verification", "nodemailer-smtp", error);
  }
}

export const emailService = {
  async sendVerificationOTP(name: string, email: string, otp: string): Promise<void> {
    const mail = { from: process.env.EMAIL_FROM, to: email, subject: "Verify your FitOS account", text: `Hi ${name},\n\nYour FitOS verification code is:\n\n${otp}\n\nThis code expires in 10 minutes.\n\nIf you did not request this code, you can safely ignore this email.\n\nRegards,\nFitOS Team` };
    if (process.env.NODE_ENV !== "production" && process.env.ENABLE_LOCAL_EMAIL_PREVIEW === "true" && !smtpConfigured()) {
      saveLocalMail({ email: email.toLowerCase(), subject: mail.subject, text: mail.text, createdAt: Date.now() });
      return;
    }
    await sendSmtpMail(mail, "registration");
  },
  async sendPasswordResetOTP(name: string, email: string, otp: string): Promise<void> {
    const mail = { from: process.env.EMAIL_FROM, to: email, subject: "Reset your FitOS password", text: `Hi ${name},\n\nYour FitOS password reset code is:\n\n${otp}\n\nThis code expires in 10 minutes. If you did not request it, ignore this email.\n\nFitOS Team` };
    if (process.env.NODE_ENV !== "production" && process.env.ENABLE_LOCAL_EMAIL_PREVIEW === "true" && !smtpConfigured()) {
      saveLocalMail({ email: email.toLowerCase(), subject: mail.subject, text: mail.text, createdAt: Date.now() });
      return;
    }
    await sendSmtpMail(mail, "password_reset");
  },
  async verifyTransport(): Promise<void> {
    if (!smtpConfigured()) {
      console.info("[EMAIL] SMTP transport verification: SKIPPED (configuration incomplete)");
      return;
    }
    await verifySmtpTransport();
  },
  timeouts: { connection: SMTP_CONNECTION_TIMEOUT_MS, greeting: SMTP_GREETING_TIMEOUT_MS, socket: SMTP_SOCKET_TIMEOUT_MS },
};
