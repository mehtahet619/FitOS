import { describe, expect, it } from "vitest";
import { MemoryBucketStore, TokenBucketRateLimiter } from "../modules/auth/tokenBucket";
import { validateRegistrationEmail } from "../modules/auth/emailValidation";

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
