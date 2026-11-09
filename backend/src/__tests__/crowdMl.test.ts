import { describe, expect, it, vi } from "vitest";
import { localHourKey, requireMlKey } from "../modules/gym/crowdMl";

function run(headerKey: string | undefined, envKey: string | undefined) {
  if (envKey === undefined) delete process.env.GYM_ML_PIPELINE_KEY; else process.env.GYM_ML_PIPELINE_KEY = envKey;
  const res: any = { statusCode: 200, body: null, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  const next = vi.fn();
  requireMlKey({ header: () => headerKey } as any, res, next);
  return { res, next };
}

describe("crowd ML bridge", () => {
  it("buckets timestamps into the gym's local hour", () => {
    expect(localHourKey("2026-10-05T02:10:00.000Z", "Asia/Kolkata")).toBe("2026-10-05T07:00:00");
    expect(localHourKey("2026-10-05T19:00:00.000Z", "Asia/Kolkata")).toBe("2026-10-06T00:00:00");
    expect(localHourKey("nope", "Asia/Kolkata")).toBeNull();
    expect(localHourKey("2026-10-05T02:10:00Z", "Not/AZone")).toBeNull();
  });

  it("rejects missing or wrong pipeline keys and accepts the right one", () => {
    expect(run("secret", undefined).res.statusCode).toBe(503);
    expect(run(undefined, "secret").res.statusCode).toBe(401);
    expect(run("wrong!", "secret").res.statusCode).toBe(401);
    const ok = run("secret", "secret");
    expect(ok.next).toHaveBeenCalled();
    delete process.env.GYM_ML_PIPELINE_KEY;
  });
});
