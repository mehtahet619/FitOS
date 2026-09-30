import { isDisposableEmailDomain } from "disposable-email-domains-js";
import { resolveMx } from "node:dns/promises";

export type EmailValidation = { valid: true; email: string } | { valid: false; code: string; message: string };

export async function validateRegistrationEmail(raw: string): Promise<EmailValidation> {
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { valid: false, code: "INVALID_EMAIL", message: "Please enter a valid email address." };
  }
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (isDisposableEmailDomain(domain)) {
    return { valid: false, code: "DISPOSABLE_EMAIL", message: "Temporary or disposable email addresses are not allowed. Please use a permanent email address." };
  }
  if (process.env.EMAIL_REQUIRE_MX === "true") {
    try { if ((await resolveMx(domain)).length === 0) throw new Error("no MX"); }
    catch { return { valid: false, code: "INVALID_EMAIL_DOMAIN", message: "Please use a permanent email address from a supported email provider." }; }
  }
  return { valid: true, email };
}
