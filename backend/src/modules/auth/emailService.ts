import nodemailer from "nodemailer";

type LocalMail = { email: string; subject: string; text: string; createdAt: number };
const localOutbox: LocalMail[] = [];
const LOCAL_CODE_TTL_MS = 10 * 60 * 1000;

function smtpConfigured(): boolean {
  return Boolean(process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASSWORD && process.env.EMAIL_FROM);
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

function getTransport() {
  const { EMAIL_HOST, EMAIL_USER, EMAIL_PASSWORD, EMAIL_FROM } = process.env;
  if (!EMAIL_HOST || !EMAIL_USER || !EMAIL_PASSWORD || !EMAIL_FROM) throw new Error("Transactional email is not configured");
  return nodemailer.createTransport({ host: EMAIL_HOST, port: Number(process.env.EMAIL_PORT || 587), secure: process.env.EMAIL_PORT === "465", auth: { user: EMAIL_USER, pass: EMAIL_PASSWORD } });
}

export const emailService = {
  async sendVerificationOTP(name: string, email: string, otp: string): Promise<void> {
    const mail = { from: process.env.EMAIL_FROM, to: email, subject: "Verify your FitOS account", text: `Hi ${name},\n\nYour FitOS verification code is:\n\n${otp}\n\nThis code expires in 10 minutes.\n\nIf you did not request this code, you can safely ignore this email.\n\nRegards,\nFitOS Team` };
    if (process.env.NODE_ENV !== "production" && process.env.ENABLE_LOCAL_EMAIL_PREVIEW === "true" && !smtpConfigured()) {
      saveLocalMail({ email: email.toLowerCase(), subject: mail.subject, text: mail.text, createdAt: Date.now() });
      return;
    }
    await getTransport().sendMail(mail);
  },
  async sendPasswordResetOTP(name: string, email: string, otp: string): Promise<void> {
    const mail = { from: process.env.EMAIL_FROM, to: email, subject: "Reset your FitOS password", text: `Hi ${name},\n\nYour FitOS password reset code is:\n\n${otp}\n\nThis code expires in 10 minutes. If you did not request it, ignore this email.\n\nFitOS Team` };
    if (process.env.NODE_ENV !== "production" && process.env.ENABLE_LOCAL_EMAIL_PREVIEW === "true" && !smtpConfigured()) {
      saveLocalMail({ email: email.toLowerCase(), subject: mail.subject, text: mail.text, createdAt: Date.now() });
      return;
    }
    await getTransport().sendMail(mail);
  },
};
