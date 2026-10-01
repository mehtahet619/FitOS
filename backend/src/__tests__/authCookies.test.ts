import { afterEach, describe, expect, it } from "vitest";
import { clearSessionCookies, setSessionCookies } from "../common/auth";

const previousNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});

function cookieRecorder() {
  const calls: Array<{ method: string; name: string; value?: string; options: Record<string, unknown> }> = [];
  const response = {
    cookie(name: string, value: string, options: Record<string, unknown>) {
      calls.push({ method: "set", name, value, options });
      return this;
    },
    clearCookie(name: string, options: Record<string, unknown>) {
      calls.push({ method: "clear", name, options });
      return this;
    },
  };
  return { calls, response: response as never };
}

describe("web session cookies", () => {
  it("sets cross-site production cookies usable by credentialed frontend fetches", () => {
    process.env.NODE_ENV = "production";
    const { calls, response } = cookieRecorder();
    setSessionCookies(response, "access", "refresh");

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.options).toMatchObject({
        httpOnly: true,
        secure: true,
        sameSite: "none",
        partitioned: true,
        path: "/",
      });
      expect(call.options).not.toHaveProperty("domain");
    }
    expect(calls.map((call) => call.options.maxAge)).toEqual([15 * 60 * 1000, 30 * 24 * 60 * 60 * 1000]);
  });

  it("clears production cookies with matching scope and cross-site attributes", () => {
    process.env.NODE_ENV = "production";
    const { calls, response } = cookieRecorder();
    clearSessionCookies(response);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.method).toBe("clear");
      expect(call.options).toMatchObject({ httpOnly: true, secure: true, sameSite: "none", partitioned: true, path: "/" });
    }
  });

  it("keeps localhost development cookies same-site without Secure", () => {
    process.env.NODE_ENV = "development";
    const { calls, response } = cookieRecorder();
    setSessionCookies(response, "access", "refresh");
    expect(calls[0].options).toMatchObject({ httpOnly: true, secure: false, sameSite: "lax", path: "/" });
    expect(calls[0].options).not.toHaveProperty("partitioned");
  });
});
