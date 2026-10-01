import { afterEach, describe, expect, it } from "vitest";
import { emailService, getEmailConfigStatus, getLocalVerificationCode } from "../modules/auth/emailService";

const original = {
  apiKey: process.env.RESEND_API_KEY,
  from: process.env.EMAIL_FROM,
  nodeEnv: process.env.NODE_ENV,
  preview: process.env.ENABLE_LOCAL_EMAIL_PREVIEW,
};

afterEach(() => {
  for (const [key, value] of Object.entries({
    RESEND_API_KEY: original.apiKey,
    EMAIL_FROM: original.from,
    NODE_ENV: original.nodeEnv,
    ENABLE_LOCAL_EMAIL_PREVIEW: original.preview,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("SMTP transport configuration", () => {
  it("checks Resend configuration without exposing credentials", () => {
    process.env.RESEND_API_KEY = "test-resend-api-key";
    process.env.EMAIL_FROM = "sender@example.test";
    expect(getEmailConfigStatus()).toEqual({ providerConfigured: true, senderConfigured: true, credentialsConfigured: true });
  });

  it("keeps the local email preview behavior", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    process.env.NODE_ENV = "development";
    process.env.ENABLE_LOCAL_EMAIL_PREVIEW = "true";
    const address = "local-preview@example.test";
    await emailService.sendVerificationOTP("Preview User", address, "483921");
    expect(getLocalVerificationCode(address)).toEqual({ subject: "Verify your FitOS account", code: "483921" });
  });
});
