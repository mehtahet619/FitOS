import { recordAiRequest } from "./metrics";
/**
 * Shared AI transport for FACHS.
 *
 * This module owns provider-specific HTTP formats, bounded retries, deadlines,
 * per-process concurrency protection and safe telemetry. Feature modules remain
 * responsible for validating the returned content against their own domain rules.
 */
export type AiProviderName = "OpenRouter" | "Anthropic" | "OpenAI";

export interface AiTextProvider {
  name: AiProviderName;
  apiKey: string;
  model: string;
  url: string;
}

export interface AiTextRequest {
  operation: string;
  provider: AiTextProvider;
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
  json?: boolean;
  timeoutMs: number;
  retries?: number;
}

const MAX_CONCURRENT_AI_REQUESTS = 12;
const MAX_TRANSIENT_RETRIES = 1;
let activeRequests = 0;

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    /timed? ?out|abort/i.test(error.message)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function providerRequest(provider: AiTextProvider, input: AiTextRequest): {
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const anthropic = provider.name === "Anthropic";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(anthropic
      ? { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${provider.apiKey}` }),
  };

  if (provider.name === "OpenRouter") {
    headers["HTTP-Referer"] = "https://fitos.app";
    headers["X-Title"] = "FACHS";
  }

  const body: Record<string, unknown> = anthropic
    ? {
        model: provider.model,
        max_tokens: input.maxTokens,
        temperature: input.temperature ?? 0.1,
        system: input.system,
        messages: [{ role: "user", content: input.user }],
      }
    : {
        model: provider.model,
        max_tokens: input.maxTokens,
        temperature: input.temperature ?? 0.1,
        ...(input.json ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
      };

  return { headers, body };
}

function extractText(provider: AiTextProvider, payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    throw new Error(`${provider.name} returned an invalid response envelope.`);
  }

  const data = payload as Record<string, any>;
  const content = provider.name === "Anthropic"
    ? data.content?.find((block: any) => block?.type === "text")?.text
    : data.choices?.[0]?.message?.content;

  if (typeof content !== "string" || !content.trim()) {
    throw new Error(`${provider.name} returned an empty response.`);
  }

  return content.trim();
}

export async function requestAiText(input: AiTextRequest): Promise<string> {
  if (!input.provider.apiKey) throw new Error(`${input.provider.name} is not configured.`);
  if (activeRequests >= MAX_CONCURRENT_AI_REQUESTS) {
    throw new Error("AI_CONCURRENCY_LIMIT: FACHS AI capacity is temporarily busy.");
  }

  activeRequests += 1;
  const startedAt = Date.now();
  const timeoutMs = Math.max(250, Math.min(input.timeoutMs, 30_000));
  const retries = Math.max(0, Math.min(input.retries ?? 1, MAX_TRANSIENT_RETRIES));
  let finalStatus: number | undefined;

  try {
    const request = providerRequest(input.provider, input);

    const deadlineAt = startedAt + timeoutMs;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`${input.provider.name} request timed out after ${timeoutMs}ms.`);
      }
      try {
        const response = await fetch(input.provider.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(request.body),
          signal: AbortSignal.timeout(remainingMs),
        });
        finalStatus = response.status;

        if (!response.ok) {
          const error = new Error(`${input.provider.name} request failed with HTTP ${response.status}.`);
          if (!isRetryableStatus(response.status) || attempt >= retries) throw error;
          await sleep(150 * (attempt + 1));
          continue;
        }

        const payload: unknown = await response.json();
        const text = extractText(input.provider, payload);
        recordAiRequest({
          operation: input.operation,
          provider: input.provider.name,
          outcome: "success",
          latencyMs: Date.now() - startedAt,
        });
        console.info(JSON.stringify({
          event: "fitos_ai_request",
          operation: input.operation,
          provider: input.provider.name,
          status: response.status,
          durationMs: Date.now() - startedAt,
          success: true,
        }));
        return text;
      } catch (error) {
        if (isAbortError(error)) throw new Error(`${input.provider.name} request timed out after ${timeoutMs}ms.`);
        if (attempt >= retries || (error instanceof Error && /HTTP 4\d\d/.test(error.message) && !/HTTP 408|HTTP 425|HTTP 429/.test(error.message))) {
          throw error;
        }
        await sleep(150 * (attempt + 1));
      }
    }

    throw new Error(`${input.provider.name} request failed after retry.`);
  } catch (error) {
    recordAiRequest({
      operation: input.operation,
      provider: input.provider.name,
      outcome: "error",
      latencyMs: Date.now() - startedAt,
    });
    console.warn(JSON.stringify({
      event: "fitos_ai_request",
      operation: input.operation,
      provider: input.provider.name,
      status: finalStatus ?? null,
      durationMs: Date.now() - startedAt,
      success: false,
      error: error instanceof Error ? error.message.slice(0, 240) : "unknown_error",
    }));
    throw error;
  } finally {
    activeRequests = Math.max(0, activeRequests - 1);
  }
}
