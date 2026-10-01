import { afterEach, describe, expect, it } from "vitest";
import { getTransport } from "../modules/auth/emailService";

const original = {
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  user: process.env.EMAIL_USER,
  password: process.env.EMAIL_PASSWORD,
  from: process.env.EMAIL_FROM,
};

afterEach(() => {
  for (const [key, value] of Object.entries({
    EMAIL_HOST: original.host,
    EMAIL_PORT: original.port,
    EMAIL_USER: original.user,
    EMAIL_PASSWORD: original.password,
    EMAIL_FROM: original.from,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("SMTP transport configuration", () => {
  it.each([
    { port: "587", secure: false, requireTLS: true },
    { port: "465", secure: true, requireTLS: false },
  ])("sets TLS mode and bounded timeouts for port $port", ({ port, secure, requireTLS }) => {
    process.env.EMAIL_HOST = "smtp.example.test";
    process.env.EMAIL_PORT = port;
    process.env.EMAIL_USER = "sender@example.test";
    process.env.EMAIL_PASSWORD = "test-password-only";
    process.env.EMAIL_FROM = "sender@example.test";

    const transport = getTransport();
    const options = (transport as unknown as { options: Record<string, unknown> }).options;
    expect(options).toMatchObject({
      host: "smtp.example.test",
      port: Number(port),
      secure,
      requireTLS,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    transport.close();
  });
});
