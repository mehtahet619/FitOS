/**
 * Server-side client for the FitOS Comparative Exercise API
 * (https://fitos-comparison-api.onrender.com).
 *
 * Contract taken from the service's published OpenAPI document:
 *   GET  /health    -> { status, service }
 *   GET  /exercises -> supported exercise catalogue
 *   POST /compare   -> { exercise_id, reference_sequence, user_sequence }
 *   auth: `x-api-key` header; a bad/missing key answers 401 {"detail":"Invalid API key."}
 *
 * The API key is read from the backend environment and is never returned to the
 * browser, logged, or embedded in a response body. Only the backend talks to
 * this service.
 */

export type ComparisonFailureKind =
  | "not_configured"
  | "unauthorized"
  | "timeout"
  | "unavailable"
  | "invalid_response";

export class ComparisonError extends Error {
  readonly kind: ComparisonFailureKind;
  readonly status: number | null;

  constructor(kind: ComparisonFailureKind, message: string, status: number | null = null) {
    super(message);
    this.name = "ComparisonError";
    this.kind = kind;
    this.status = status;
  }
}

export interface ComparisonExercise {
  id: string;
  name: string;
}

export interface ComparisonRequestPayload {
  exercise_id: string;
  reference_sequence: number[][];
  user_sequence: number[][];
}

export interface ComparisonProvider {
  readonly name: string;
  readonly configured: boolean;
  /** Supported exercise catalogue, cached briefly to avoid re-hitting the API. */
  listExercises(): Promise<ComparisonExercise[]>;
  compare(payload: ComparisonRequestPayload): Promise<unknown>;
}

interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<FetchResponseLike>;

interface ComparisonProviderOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TIMEOUT_MS = 20000;
const EXERCISE_CACHE_TTL_MS = 10 * 60 * 1000;

function boundedTimeout(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, MAX_TIMEOUT_MS);
}

/**
 * Reads the two documented environment variables. Returns null when the feature
 * is not configured so callers can fail closed instead of throwing at startup.
 */
export function getComparisonConfig(): { baseUrl: string; apiKey: string; timeoutMs: number } | null {
  const rawUrl = (process.env.FITOS_COMPARISON_API_URL || "").trim();
  const apiKey = (process.env.FITOS_API_KEY || "").trim();
  if (!rawUrl || !apiKey) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return {
    baseUrl: `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`,
    apiKey,
    timeoutMs: boundedTimeout(process.env.FITOS_COMPARISON_TIMEOUT_MS),
  };
}

function coerceExerciseList(raw: unknown): ComparisonExercise[] {
  const container = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === "object" && (Array.isArray((raw as any).exercises) ? (raw as any).exercises : (raw as any).items)) || [];
  if (!Array.isArray(container)) return [];
  const out: ComparisonExercise[] = [];
  for (const entry of container) {
    if (typeof entry === "string") {
      out.push({ id: entry, name: entry });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as any).id ?? (entry as any).exercise_id ?? (entry as any).slug ?? (entry as any).key;
    if (typeof id !== "string" || !id.trim()) continue;
    const name = (entry as any).name ?? (entry as any).display_name ?? (entry as any).label ?? id;
    out.push({ id: id.trim(), name: String(name) });
  }
  return out;
}

export function createComparisonProvider(options: ComparisonProviderOptions): ComparisonProvider {
  const fetchImpl = options.fetchImpl ?? ((globalThis.fetch as unknown) as FetchLike);
  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  let cachedExercises: { at: number; exercises: ComparisonExercise[] } | null = null;

  async function requestJson(path: string, init: { method: string; body?: string }): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: FetchResponseLike;
    try {
      response = await fetchImpl(`${options.baseUrl}${path}`, {
        method: init.method,
        headers: { "x-api-key": options.apiKey, accept: "application/json" },
        body: init.body,
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = (error as { name?: string } | null)?.name === "AbortError";
      throw new ComparisonError(
        aborted ? "timeout" : "unavailable",
        aborted ? "Comparison service timed out." : "Comparison service is unreachable.",
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      throw new ComparisonError("unauthorized", "Comparison service rejected the configured credentials.", response.status);
    }
    if (!response.ok) {
      throw new ComparisonError("unavailable", `Comparison service returned HTTP ${response.status}.`, response.status);
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new ComparisonError("unavailable", "Comparison service response could not be read.", response.status);
    }
    if (!text.trim()) {
      throw new ComparisonError("invalid_response", "Comparison service returned an empty body.", response.status);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ComparisonError("invalid_response", "Comparison service returned malformed JSON.", response.status);
    }
  }

  return {
    name: "fitos-comparison-api",
    configured: true,
    async listExercises() {
      const now = Date.now();
      if (cachedExercises && now - cachedExercises.at < EXERCISE_CACHE_TTL_MS) return cachedExercises.exercises;
      const parsed = coerceExerciseList(await requestJson("/exercises", { method: "GET" }));
      if (parsed.length === 0) {
        throw new ComparisonError("invalid_response", "Comparison service returned no supported exercises.");
      }
      // Successes only: a failure is never cached, so the feature recovers on
      // its own as soon as the service answers again.
      cachedExercises = { at: now, exercises: parsed };
      return parsed;
    },
    compare(payload) {
      return requestJson("/compare", { method: "POST", body: JSON.stringify(payload) });
    },
  };
}

let providerOverride: ComparisonProvider | null | undefined;
let defaultProvider: ComparisonProvider | null | undefined;

/** Returns null when FITOS_COMPARISON_API_URL / FITOS_API_KEY are not set. */
export function getComparisonProvider(): ComparisonProvider | null {
  if (providerOverride !== undefined) return providerOverride;
  if (defaultProvider === undefined) {
    const config = getComparisonConfig();
    defaultProvider = config ? createComparisonProvider(config) : null;
  }
  return defaultProvider;
}

export function setComparisonProviderForTests(provider: ComparisonProvider | null | undefined): void {
  providerOverride = provider;
  defaultProvider = undefined;
}
