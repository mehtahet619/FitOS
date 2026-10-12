import { Resend } from "resend";
import { logOtpFailure } from "./otpDiagnostics";

type LocalMail = { email: string; subject: string; text: string; createdAt: number };
const localOutbox: LocalMail[] = [];
const LOCAL_CODE_TTL_MS = 10 * 60 * 1000;
function resendConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim() && process.env.EMAIL_FROM?.trim());
}

export function getEmailConfigStatus(): { providerConfigured: boolean; senderConfigured: boolean; credentialsConfigured: boolean } {
  const apiKeyConfigured = Boolean(process.env.RESEND_API_KEY?.trim());
  return {
    providerConfigured: apiKeyConfigured,
    senderConfigured: Boolean(process.env.EMAIL_FROM?.trim()),
    credentialsConfigured: apiKeyConfigured,
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

async function sendResendMail(mail: { to: string; subject: string; text: string }, flow: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured");
  if (!from) throw new Error("EMAIL_FROM is not configured");

  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({ from, ...mail });
    if (error) throw new Error(error.message || "Resend rejected the email request");
  } catch (error) {
    console.error("[OTP] email send failed", JSON.stringify({ flow, provider: "resend-api" }));
    logOtpFailure(`email_send_${flow}`, "resend-api", error);
    throw error;
  }
}

async function verifyResendTransport(): Promise<void> {
  const status = getEmailConfigStatus();
  if (!status.providerConfigured) console.error("[EMAIL] RESEND_API_KEY is not configured");
  if (!status.senderConfigured) console.error("[EMAIL] EMAIL_FROM is not configured");
  if (status.providerConfigured && status.senderConfigured) console.info("[EMAIL] Resend configuration verification: OK");
}

export const emailService = {
  async sendLoginOTP(name: string, email: string, otp: string): Promise<void> {
    const mail = { to: email, subject: "Your FitOS sign-in code", text: `Hi ${name},\n\nYour FitOS sign-in code is:\n\n${otp}\n\nThis code expires in 10 minutes and can only be used once. If you did not request it, you can safely ignore this email.\n\nFitOS Team` };
    await sendResendMail(mail, "login");
  },
  async sendVerificationOTP(name: string, email: string, otp: string): Promise<void> {
    const mail = { from: process.env.EMAIL_FROM, to: email, subject: "Verify your FitOS account", text: `Hi ${name},\n\nYour FitOS verification code is:\n\n${otp}\n\nThis code expires in 10 minutes.\n\nIf you did not request this code, you can safely ignore this email.\n\nRegards,\nFitOS Team` };
    if (process.env.NODE_ENV !== "production" && process.env.ENABLE_LOCAL_EMAIL_PREVIEW === "true" && !resendConfigured()) {
      saveLocalMail({ email: email.toLowerCase(), subject: mail.subject, text: mail.text, createdAt: Date.now() });
      return;
    }
    await sendResendMail({ to: mail.to, subject: mail.subject, text: mail.text }, "registration");
  },
  async sendPasswordResetOTP(name: string, email: string, otp: string): Promise<void> {
    const mail = { from: process.env.EMAIL_FROM, to: email, subject: "Reset your FitOS password", text: `Hi ${name},\n\nYour FitOS password reset code is:\n\n${otp}\n\nThis code expires in 10 minutes.\n\nIf you did not request this code, ignore this email.\n\nFitOS Team` };
    if (process.env.NODE_ENV !== "production" && process.env.ENABLE_LOCAL_EMAIL_PREVIEW === "true" && !resendConfigured()) {
      saveLocalMail({ email: email.toLowerCase(), subject: mail.subject, text: mail.text, createdAt: Date.now() });
      return;
    }
    await sendResendMail({ to: mail.to, subject: mail.subject, text: mail.text }, "password_reset");
  },
  async verifyTransport(): Promise<void> {
    await verifyResendTransport();
  },
};
