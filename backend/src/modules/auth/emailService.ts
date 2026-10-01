import nodemailer from "nodemailer";

type LocalMail = { email: string; subject: string; text: string; createdAt: number };
const localOutbox: LocalMail[] = [];
const LOCAL_CODE_TTL_MS = 10 * 60 * 1000;

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
  const secure = Number(process.env.EMAIL_PORT) === 465;
  
  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT || 587),
    secure: Number(process.env.EMAIL_PORT) === 465,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD },
    // Explicit SMTP timeouts to prevent hanging
    connectionTimeout: 10000,    // 10 seconds to establish connection
    greetingTimeout: 10000,      // 10 seconds for greeting
    socketTimeout: 15000,        // 15 seconds for socket operations
  });
}

export const emailService = {
  async sendVerificationOTP(name: string, email: string, otp: string): Promise<void> {
    const mail = { from: process.env.EMAIL_FROM, to: email, subject: "Verify your FitOS account", text: `Hi ${name},\n\nYour FitOS verification code is:\n\n${otp}\n\nThis code expires in 10 minutes.\n\nIf you did not request this code, you can safely ignore this email.\n\nRegards,\nFitOS Team` };
    if (process.env.NODE_ENV !== "production" && process.env.ENABLE_LOCAL_EMAIL_PREVIEW === "true" && !smtpConfigured()) {
      saveLocalMail({ email: email.toLowerCase(), subject: mail.subject, text: mail.text, createdAt: Date.now() });
      return;
    }
    try {
      console.log("[OTP] email send started", { flow: "registration", to: email });
      await getTransport().sendMail(mail);
      console.log("[OTP] email send succeeded", { flow: "registration", to: email });
    } catch (error: any) {
      console.error("[OTP] email send failed", { provider: "nodemailer-smtp", to: email, error: error?.message || String(error) });
      throw error;
    }
  },
  async sendPasswordResetOTP(name: string, email: string, otp: string): Promise<void> {
    const mail = { from: process.env.EMAIL_FROM, to: email, subject: "Reset your FitOS password", text: `Hi ${name},\n\nYour FitOS password reset code is:\n\n${otp}\n\nThis code expires in 10 minutes. If you did not request it, ignore this email.\n\nFitOS Team` };
    if (process.env.NODE_ENV !== "production" && process.env.ENABLE_LOCAL_EMAIL_PREVIEW === "true" && !smtpConfigured()) {
      saveLocalMail({ email: email.toLowerCase(), subject: mail.subject, text: mail.text, createdAt: Date.now() });
      return;
    }
    try {
      console.log("[OTP] email send started", { flow: "password_reset", to: email });
      await getTransport().sendMail(mail);
      console.log("[OTP] email send succeeded", { flow: "password_reset", to: email });
    } catch (error: any) {
      console.error("[OTP] email send failed", { provider: "nodemailer-smtp", to: email, error: error?.message || String(error) });
      throw error;
    }
  },
};
