const EMAIL_PATTERN = /\b([A-Z0-9._%+-])[A-Z0-9._%+-]*@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;

export function maskEmail(email: string): string {
  const [local, domain] = email.trim().toLowerCase().split("@");
  if (!local || !domain) return "[invalid-email]";
  return `${local[0]}***@${domain}`;
}

export function safeOtpError(error: unknown): { name: string; message: string } {
  const err = error instanceof Error ? error : new Error("Unknown error");
  let message = err.message || "No error message";
  const sensitiveValues = [
    process.env.RESEND_API_KEY,
    process.env.BREVO_API_KEY,
    process.env.UPSTASH_REDIS_REST_TOKEN,
    process.env.UPSTASH_REDIS_REST_URL,
    process.env.EMAIL_FROM,
  ].filter((value): value is string => Boolean(value));
  for (const value of sensitiveValues) message = message.split(value).join("[redacted]");
  message = message
    .replace(/Bearer\s+[^\s,]+/gi, "Bearer [redacted]")
    .replace(EMAIL_PATTERN, "$1***@$2")
    .replace(/\b\d{6}\b/g, "[redacted]")
    .replace(/(password|token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 240);
  return { name: err.name || "Error", message };
}

export function logOtpStage(event: string, fields: Record<string, string | boolean> = {}): void {
  console.info(`[OTP] ${event}`, JSON.stringify(fields));
}

export function logOtpFailure(operation: string, provider: string, error: unknown): void {
  console.error("[OTP] SERVICE ERROR", JSON.stringify({ operation, provider, ...safeOtpError(error) }));
}
