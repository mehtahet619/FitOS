import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// requireAuth reads the session from the database. The comparison contract is
// what is under test here, so the lookup is stubbed to always resolve a session.
vi.mock("../db/client", () => ({
  db: {
    get: async () => ({ id: "session-1", userId: "user-1" }),
    all: async () => [],
    run: async () => ({ changes: 1 }),
    exec: async () => undefined,
    transaction: async (work: (tx: unknown) => unknown) => work(undefined),
  },
  nowIso: () => new Date().toISOString(),
}));

import { signAccessToken } from "../common/auth";
import { comparisonRouter, COMPARISON_BODY_LIMIT } from "../modules/comparison/routes";
import {
  ComparisonError,
  createComparisonProvider,
  getComparisonConfig,
  getComparisonProvider,
  setComparisonProviderForTests,
} from "../modules/comparison/comparisonProvider";
import type { ComparisonExercise, ComparisonProvider } from "../modules/comparison/comparisonProvider";
import { matchSupportedExercise } from "../modules/comparison/exerciseMapping";
import { normalizeComparison } from "../modules/comparison/comparisonResult";

const CATALOGUE: ComparisonExercise[] = [
  { id: "squat", name: "Squat" },
  { id: "bicep_curl", name: "Bicep Curl" },
  { id: "push_up", name: "Push-Up" },
];

const VALID_SEQUENCE = [[0.1, 0.2, 0.3, 0.9], [0.2, 0.3, 0.4, 0.9]];
const VALID_BODY = {
  exerciseKey: "squat",
  exerciseName: "Squat",
  referenceSequence: VALID_SEQUENCE,
  sequence: VALID_SEQUENCE,
};

function stubProvider(overrides: Partial<ComparisonProvider> = {}): ComparisonProvider {
  return {
    name: "stub",
    configured: true,
    listExercises: async () => [...CATALOGUE],
    compare: async () => ({ form_score: 88, corrections: ["Keep your chest up"] }),
    ...overrides,
  };
}

async function startServer(provider: ComparisonProvider | null): Promise<{ server: Server; baseUrl: string }> {
  setComparisonProviderForTests(provider);
  const app = express();
  // Mounted exactly like server.ts: a bounded parser in front of the router.
  app.use("/comparison", express.json({ limit: COMPARISON_BODY_LIMIT }), comparisonRouter);
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${signAccessToken("user-1", "session-1")}`,
  };
}

describe("comparison response normaliser", () => {
  it("surfaces only the fields the service actually returned", () => {
    const analysis = normalizeComparison({
      form_score: 82.5,
      confidence: 0.9,
      summary: "Solid depth, keep your chest up.",
      differences: [
        { joint: "LEFT_KNEE", deviation: 14.2, detail: "Left knee caved inward" },
        { joint: "RIGHT_KNEE", deviation: 9.1 },
      ],
      corrections: ["Drive your knees out", "Keep your chest tall"],
    }, { exerciseId: "squat", exerciseName: "Squat" });

    expect(analysis).not.toBeNull();
    expect(analysis?.formScore).toBe(82.5);
    expect(analysis?.formScorePercent).toBe(82.5);
    expect(analysis?.confidence).toBe(0.9);
    expect(analysis?.corrections).toEqual(["Drive your knees out", "Keep your chest tall"]);
    expect(analysis?.differences[0]).toEqual({ part: "Left knee", detail: "Left knee caved inward", deviation: 14.2 });
    expect(analysis?.differences[1]).toEqual({ part: "Right knee", detail: null, deviation: 9.1 });
  });

  it("finds values nested inside a result/data wrapper", () => {
    const analysis = normalizeComparison(
      { result: { data: { score: 0.72, corrections: ["Slow the descent"] } } },
      { exerciseId: "bicep_curl", exerciseName: "Bicep Curl" },
    );
    expect(analysis?.formScore).toBe(0.72);
    expect(analysis?.formScorePercent).toBe(72);
    expect(analysis?.corrections).toEqual(["Slow the descent"]);
  });

  it("never fabricates a score, summary, or correction", () => {
    const analysis = normalizeComparison({ status: "ok", exercise_id: "squat" }, { exerciseId: "squat", exerciseName: "Squat" });
    // Nothing recognisable came back, so the caller must report "no usable result".
    expect(analysis).toBeNull();
  });

  it("returns null for empty or non-object payloads", () => {
    expect(normalizeComparison(null, { exerciseId: "squat", exerciseName: null })).toBeNull();
    expect(normalizeComparison(undefined, { exerciseId: "squat", exerciseName: null })).toBeNull();
    expect(normalizeComparison("not an object", { exerciseId: "squat", exerciseName: null })).toBeNull();
    expect(normalizeComparison({}, { exerciseId: "squat", exerciseName: null })).toBeNull();
  });

  it("drops a difference detail that only repeats the joint name", () => {
    const analysis = normalizeComparison(
      { differences: [{ joint: "knee", detail: "knee" }] },
      { exerciseId: "squat", exerciseName: "Squat" },
    );
    expect(analysis?.differences[0]).toEqual({ part: "Knee", detail: null, deviation: null });
  });

  it("keeps differences but leaves the score null when no score was returned", () => {
    const analysis = normalizeComparison(
      { differences: [{ joint: "hip", deviation: 12 }] },
      { exerciseId: "squat", exerciseName: "Squat" },
    );
    expect(analysis?.formScore).toBeNull();
    expect(analysis?.formScorePercent).toBeNull();
    expect(analysis?.differences).toHaveLength(1);
  });

  it("rejects out-of-range confidence instead of trusting it", () => {
    const analysis = normalizeComparison(
      { score: 70, confidence: 4.2 },
      { exerciseId: "squat", exerciseName: "Squat" },
    );
    expect(analysis?.confidence).toBeNull();
  });
});

describe("comparison exercise matching", () => {
  it("matches Vision Coach keys onto the service's own catalogue ids", () => {
    expect(matchSupportedExercise("squat", CATALOGUE)).toMatchObject({ matched: true, exerciseId: "squat" });
    expect(matchSupportedExercise("curl", CATALOGUE)).toMatchObject({ matched: true, exerciseId: "bicep_curl" });
    expect(matchSupportedExercise("pushup", CATALOGUE)).toMatchObject({ matched: true, exerciseId: "push_up" });
  });

  it("reports an unsupported movement instead of guessing an id", () => {
    expect(matchSupportedExercise("benchpress", CATALOGUE)).toEqual({ matched: false, exerciseId: null, exerciseName: null });
    expect(matchSupportedExercise("squat", [])).toEqual({ matched: false, exerciseId: null, exerciseName: null });
  });
});

describe("comparison provider configuration", () => {
  afterEach(() => {
    delete process.env.FITOS_COMPARISON_API_URL;
    delete process.env.FITOS_API_KEY;
    delete process.env.FITOS_COMPARISON_TIMEOUT_MS;
    setComparisonProviderForTests(undefined);
  });

  it("is unconfigured when the environment variables are missing", () => {
    expect(getComparisonConfig()).toBeNull();
  });

  it("is unconfigured when the configured URL is not a valid URL", () => {
    process.env.FITOS_COMPARISON_API_URL = "not-a-url";
    process.env.FITOS_API_KEY = "secret";
    expect(getComparisonConfig()).toBeNull();
  });

  it("reads the base URL and key, and clamps the timeout", () => {
    process.env.FITOS_COMPARISON_API_URL = "https://fitos-comparison-api.onrender.com/";
    process.env.FITOS_API_KEY = "  server-side-key  ";
    process.env.FITOS_COMPARISON_TIMEOUT_MS = "999999";
    const config = getComparisonConfig();
    expect(config?.baseUrl).toBe("https://fitos-comparison-api.onrender.com");
    expect(config?.apiKey).toBe("server-side-key");
    expect(config?.timeoutMs).toBe(20000);
  });
});

describe("comparison provider transport", () => {
  function providerWith(fetchImpl: unknown) {
    return createComparisonProvider({
      baseUrl: "https://comparison.test",
      apiKey: "server-side-key",
      fetchImpl: fetchImpl as never,
    });
  }

  it("sends the key server-side only and parses a successful compare", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init: { headers: Record<string, string>; body?: string }) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return { ok: true, status: 200, text: async () => JSON.stringify({ form_score: 91 }) };
    });

    const result = await providerWith(fetchImpl).compare({
      exercise_id: "squat",
      reference_sequence: VALID_SEQUENCE,
      user_sequence: VALID_SEQUENCE,
    });

    expect(result).toEqual({ form_score: 91 });
    expect(calls[0].url).toBe("https://comparison.test/compare");
    expect(calls[0].headers["x-api-key"]).toBe("server-side-key");
    // The key is sent upstream, but must never appear in the returned payload.
    expect(JSON.stringify(result)).not.toContain("server-side-key");
  });

  it("maps upstream 5xx to unavailable", async () => {
    const provider = providerWith(async () => ({ ok: false, status: 500, text: async () => "boom" }));
    await expect(provider.compare({ exercise_id: "squat", reference_sequence: [], user_sequence: [] }))
      .rejects.toMatchObject({ kind: "unavailable", status: 500 });
  });

  it("maps an aborted request to timeout", async () => {
    const provider = providerWith(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    await expect(provider.compare({ exercise_id: "squat", reference_sequence: [], user_sequence: [] }))
      .rejects.toMatchObject({ kind: "timeout" });
  });

  it("maps an empty body and malformed JSON to invalid_response", async () => {
    await expect(providerWith(async () => ({ ok: true, status: 200, text: async () => "   " }))
      .compare({ exercise_id: "squat", reference_sequence: [], user_sequence: [] }))
      .rejects.toMatchObject({ kind: "invalid_response" });
    await expect(providerWith(async () => ({ ok: true, status: 200, text: async () => "<html>oops</html>" }))
      .compare({ exercise_id: "squat", reference_sequence: [], user_sequence: [] }))
      .rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("maps 401 to unauthorized", async () => {
    const provider = providerWith(async () => ({ ok: false, status: 401, text: async () => '{"detail":"Invalid API key."}' }));
    await expect(provider.compare({ exercise_id: "squat", reference_sequence: [], user_sequence: [] }))
      .rejects.toMatchObject({ kind: "unauthorized", status: 401 });
  });

  it("caches a successful exercise list but does not cache failures", async () => {
    let calls = 0;
    const provider = providerWith(async () => {
      calls += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify([{ id: "squat", name: "Squat" }]) };
    });
    await provider.listExercises();
    await provider.listExercises();
    expect(calls).toBe(1);

    const failing = providerWith(async () => ({ ok: false, status: 503, text: async () => "down" }));
    await expect(failing.listExercises()).rejects.toBeInstanceOf(ComparisonError);
    await expect(failing.listExercises()).rejects.toBeInstanceOf(ComparisonError);
  });
});

describe("comparison routes", () => {
  let server: Server | null = null;

  beforeEach(() => {
    setComparisonProviderForTests(undefined);
  });

  afterEach(async () => {
    setComparisonProviderForTests(undefined);
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  async function boot(provider: ComparisonProvider | null) {
    const started = await startServer(provider);
    server = started.server;
    return started.baseUrl;
  }

  it("analyzes a supported repetition and returns only the normalised result", async () => {
    const baseUrl = await boot(stubProvider());
    const response = await fetch(`${baseUrl}/comparison/analyze`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(VALID_BODY),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.available).toBe(true);
    expect(body.analysis.formScore).toBe(88);
    expect(body.analysis.corrections).toEqual(["Keep your chest up"]);
  });

  it("forwards the service's own exercise id, not the local key", async () => {
    const compare = vi.fn(async () => ({ form_score: 70 }));
    const baseUrl = await boot(stubProvider({ compare: compare as never }));
    await fetch(`${baseUrl}/comparison/analyze`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ ...VALID_BODY, exerciseKey: "curl", exerciseName: "Curl" }),
    });
    expect(compare).toHaveBeenCalledWith(expect.objectContaining({ exercise_id: "bicep_curl" }));
  });

  it("answers 503 when the service returns a server error", async () => {
    const baseUrl = await boot(stubProvider({
      compare: async () => { throw new ComparisonError("unavailable", "upstream 500", 500); },
    }));
    const response = await fetch(`${baseUrl}/comparison/analyze`, {
      method: "POST", headers: authHeaders(), body: JSON.stringify(VALID_BODY),
    });
    expect(response.status).toBe(503);
    const body = await response.json() as any;
    expect(body.code).toBe("COMPARISON_UNAVAILABLE");
    expect(body.error).toContain("temporarily unavailable");
  });

  it("answers 504 on a timeout", async () => {
    const baseUrl = await boot(stubProvider({
      compare: async () => { throw new ComparisonError("timeout", "slow"); },
    }));
    const response = await fetch(`${baseUrl}/comparison/analyze`, {
      method: "POST", headers: authHeaders(), body: JSON.stringify(VALID_BODY),
    });
    expect(response.status).toBe(504);
    expect((await response.json() as any).code).toBe("COMPARISON_TIMEOUT");
  });

  it("answers 502 when the service returns a malformed body", async () => {
    const baseUrl = await boot(stubProvider({
      compare: async () => { throw new ComparisonError("invalid_response", "junk"); },
    }));
    const response = await fetch(`${baseUrl}/comparison/analyze`, {
      method: "POST", headers: authHeaders(), body: JSON.stringify(VALID_BODY),
    });
    expect(response.status).toBe(502);
    expect((await response.json() as any).code).toBe("COMPARISON_INVALID_RESPONSE");
  });

  it("answers 502 with no result when the body is valid but unrecognisable", async () => {
    const baseUrl = await boot(stubProvider({ compare: async () => ({ status: "ok" }) }));
    const response = await fetch(`${baseUrl}/comparison/analyze`, {
      method: "POST", headers: authHeaders(), body: JSON.stringify(VALID_BODY),
    });
    expect(response.status).toBe(502);
    expect((await response.json() as any).code).toBe("COMPARISON_NO_RESULT");
  });

  it("answers 422 for a movement the service does not support", async () => {
    const baseUrl = await boot(stubProvider());
    const response = await fetch(`${baseUrl}/comparison/analyze`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ ...VALID_BODY, exerciseKey: "benchpress", exerciseName: "Bench Press" }),
    });
    expect(response.status).toBe(422);
    const body = await response.json() as any;
    expect(body.code).toBe("COMPARISON_EXERCISE_UNSUPPORTED");
    expect(body.supportedExercises).toContain("Squat");
  });

  it("fails closed with 503 when the feature is not configured", async () => {
    const baseUrl = await boot(null);
    const status = await fetch(`${baseUrl}/comparison/status`, { headers: authHeaders() });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ configured: false, available: false, supportedExercises: [] });

    const analyze = await fetch(`${baseUrl}/comparison/analyze`, {
      method: "POST", headers: authHeaders(), body: JSON.stringify(VALID_BODY),
    });
    expect(analyze.status).toBe(503);
    expect((await analyze.json() as any).code).toBe("COMPARISON_NOT_CONFIGURED");
  });

  it("never leaks credentials or upstream auth detail on an unauthorized response", async () => {
    const baseUrl = await boot(stubProvider({
      compare: async () => { throw new ComparisonError("unauthorized", "rejected", 401); },
    }));
    const response = await fetch(`${baseUrl}/comparison/analyze`, {
      method: "POST", headers: authHeaders(), body: JSON.stringify(VALID_BODY),
    });
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain("server-side-key");
    expect(text.toLowerCase()).not.toContain("api key");
    expect(text).not.toContain("401");
  });

  it("keeps /status honest when the service is unreachable", async () => {
    const baseUrl = await boot(stubProvider({
      listExercises: async () => { throw new ComparisonError("unavailable", "down", 503); },
    }));
    const response = await fetch(`${baseUrl}/comparison/status`, { headers: authHeaders() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: true, available: false, supportedExercises: [] });
  });

  it("rejects an empty or malformed pose sequence without calling the service", async () => {
    const compare = vi.fn(async () => ({ form_score: 70 }));
    const baseUrl = await boot(stubProvider({ compare: compare as never }));
    for (const body of [
      { ...VALID_BODY, sequence: [] },
      { ...VALID_BODY, sequence: [[0.1]] },
      { ...VALID_BODY, referenceSequence: "nope" },
      { exerciseKey: "squat" },
    ]) {
      const response = await fetch(`${baseUrl}/comparison/analyze`, {
        method: "POST", headers: authHeaders(), body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect((await response.json() as any).code).toBe("COMPARISON_INVALID_REQUEST");
    }
    expect(compare).not.toHaveBeenCalled();
  });

  it("requires authentication and leaves unrelated routes working", async () => {
    const baseUrl = await boot(stubProvider());
    const unauthorized = await fetch(`${baseUrl}/comparison/status`);
    expect(unauthorized.status).toBe(401);

    // A failed analysis must not affect the rest of the API.
    const failed = await fetch(`${baseUrl}/comparison/analyze`, {
      method: "POST", headers: authHeaders(), body: JSON.stringify({ ...VALID_BODY, exerciseKey: "benchpress" }),
    });
    expect(failed.status).toBe(422);
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
  });
});

describe("getComparisonProvider", () => {
  afterEach(() => {
    delete process.env.FITOS_COMPARISON_API_URL;
    delete process.env.FITOS_API_KEY;
    setComparisonProviderForTests(undefined);
  });

  it("returns null when the environment is not configured", () => {
    setComparisonProviderForTests(undefined);
    expect(getComparisonProvider()).toBeNull();
  });
});
