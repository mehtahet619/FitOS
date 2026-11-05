import { afterEach, describe, expect, it, vi } from "vitest";
import { requestAiText } from "../ai/gateway";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const provider = {
  name: "OpenRouter" as const,
  apiKey: "test-key",
  model: "test/model",
  url: "https://openrouter.ai/api/v1/chat/completions",
};

describe("shared AI gateway", () => {
  it("retries a transient 503 once within the request budget", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("upstream unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "verified response" } }],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestAiText({
      operation: "test.retry",
      provider,
      system: "Return a short answer.",
      user: "hello",
      maxTokens: 100,
      timeoutMs: 3000,
      retries: 1,
    })).resolves.toBe("verified response");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry authentication failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("unauthorized", { status: 401 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestAiText({
      operation: "test.auth",
      provider,
      system: "Return a short answer.",
      user: "hello",
      maxTokens: 100,
      timeoutMs: 3000,
      retries: 1,
    })).rejects.toThrow("HTTP 401");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the Anthropic request and response format", async () => {
    const anthropicProvider = {
      name: "Anthropic" as const,
      apiKey: "test-key",
      model: "claude-test",
      url: "https://api.anthropic.com/v1/messages",
    };
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.system).toBe("system prompt");
      return new Response(JSON.stringify({
        content: [{ type: "text", text: "anthropic answer" }],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestAiText({
      operation: "test.anthropic",
      provider: anthropicProvider,
      system: "system prompt",
      user: "question",
      maxTokens: 100,
      timeoutMs: 3000,
    })).resolves.toBe("anthropic answer");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
