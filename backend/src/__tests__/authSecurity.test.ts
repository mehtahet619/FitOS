import { describe, expect, it } from "vitest";
import { MemoryBucketStore, RedisBucketStore, TokenBucketRateLimiter } from "../modules/auth/tokenBucket";
import { validateRegistrationEmail } from "../modules/auth/emailValidation";
import { maskEmail, safeOtpError } from "../modules/auth/otpDiagnostics";

describe("OTP token bucket limiter", () => {
  it("starts with 50 email tokens, rejects the 51st, and refills at 50 per minute", async () => {
    let now = 0;
    const limiter = new TokenBucketRateLimiter(new MemoryBucketStore(), () => now);
    for (let i = 0; i < 50; i += 1) expect((await limiter.consumeRegistration("a@gmail.com", `ip-${i}`)).allowed).toBe(true);
    const limited = await limiter.consumeRegistration("a@gmail.com", "ip-49");
    expect(limited).toEqual({ allowed: false, retryAfter: 2 });
    now += 3000;
    expect((await limiter.consumeRegistration("a@gmail.com", "1.2.3.4")).allowed).toBe(true);
  });

  it("normalizes email keys, separates email buckets, and enforces IP limits independently", async () => {
    let now = 0;
    const limiter = new TokenBucketRateLimiter(new MemoryBucketStore(), () => now);
    for (let i = 0; i < 20; i += 1) expect((await limiter.consumeRegistration(`user-${i}@gmail.com`, "same-ip")).allowed).toBe(true);
    expect((await limiter.consumeRegistration("A@GMAIL.COM", "same-ip")).allowed).toBe(false);
    now += 5000;
    expect((await limiter.consumeRegistration("b@yahoo.com", "same-ip")).allowed).toBe(true);
  });

  it("handles concurrent requests without allowing more than the available bucket", async () => {
    const limiter = new TokenBucketRateLimiter(new MemoryBucketStore(), () => 0);
    const results = await Promise.all(Array.from({ length: 25 }, () => limiter.consumeRegistration("race@outlook.com", "race-ip")));
    expect(results.filter((result) => result.allowed)).toHaveLength(20);
    expect(results.filter((result) => !result.allowed)).toHaveLength(5);
  });
});

describe("registration email policy", () => {
  it("normalizes acceptable permanent mail and allows reputable providers", async () => {
    for (const value of ["  Het@GMAIL.COM ", "person@yahoo.co.in", "person@outlook.com", "person@proton.me", "person@company.example"]) {
      const result = await validateRegistrationEmail(value);
      expect(result.valid).toBe(true);
    }
    expect(await validateRegistrationEmail("  Het@GMAIL.COM ")).toEqual({ valid: true, email: "het@gmail.com" });
  });

  it("rejects malformed and disposable addresses", async () => {
    expect(await validateRegistrationEmail("not-an-email")).toMatchObject({ valid: false, code: "INVALID_EMAIL" });
    expect(await validateRegistrationEmail("user@mailinator.com")).toMatchObject({ valid: false, code: "DISPOSABLE_EMAIL" });
  });
});

describe("OTP diagnostics and Redis configuration", () => {
  it("masks email addresses and credential-like values in diagnostic errors", () => {
    const oldUrl = process.env.UPSTASH_REDIS_REST_URL;
    const oldToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const oldPassword = process.env.EMAIL_PASSWORD;
    process.env.UPSTASH_REDIS_REST_URL = "https://secret-cache.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "private-redis-token";
    process.env.EMAIL_PASSWORD = "private-smtp-password";
    try {
      const safe = safeOtpError(new Error("Request to https://secret-cache.upstash.io failed for het@gmail.com: private-redis-token private-smtp-password OTP 483921"));
      expect(safe.message).not.toContain("secret-cache.upstash.io");
      expect(safe.message).not.toContain("private-redis-token");
      expect(safe.message).not.toContain("private-smtp-password");
      expect(safe.message).not.toContain("het@gmail.com");
      expect(safe.message).not.toContain("483921");
      expect(safe.message).toContain("h***@gmail.com");
      expect(maskEmail("  Het@GMAIL.COM ")).toBe("h***@gmail.com");
    } finally {
      if (oldUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = oldUrl;
      if (oldToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = oldToken;
      if (oldPassword === undefined) delete process.env.EMAIL_PASSWORD;
      else process.env.EMAIL_PASSWORD = oldPassword;
    }
  });

  it("rejects missing credentials and non-HTTPS Redis endpoints before connecting", () => {
    expect(() => new RedisBucketStore("", "")).toThrow("Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN");
    expect(() => new RedisBucketStore("redis://cache.example", "not-a-real-token")).toThrow("UPSTASH_REDIS_REST_URL must use HTTPS");
  });

  it("supports the same connectivity probe with the local test store", async () => {
    await expect(new MemoryBucketStore().ping()).resolves.toBe("PONG");
  });
});
