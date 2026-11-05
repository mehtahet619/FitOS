import { afterEach, describe, expect, it, vi } from "vitest";
import { getAiProvider, type HealthyDishInput } from "../ai/provider";

describe("healthy-food AI provider resilience", () => {
  const originalFetch = globalThis.fetch;
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
    if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    vi.restoreAllMocks();
  });

  it("falls back to deterministic ranking when configured providers fail", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("upstream unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("upstream unavailable", { status: 503 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const dishes: HealthyDishInput[] = [
      { dishId: "dish-protein", name: "Paneer bowl", restaurantName: "Test Cafe", proteinG: 28, calories: 420 },
      { dishId: "dish-fried", name: "Fried dessert", restaurantName: "Test Cafe", proteinG: 2, calories: 700 },
    ];

    const result = await getAiProvider().analyzeHealthyDishes({ dishes });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
    expect(result.map((item) => item.dishId).sort()).toEqual(["dish-fried", "dish-protein"]);
    expect(result.every((item) => item.nutritionConfidence === "estimated")).toBe(true);
  });
});
