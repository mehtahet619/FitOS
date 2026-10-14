import { afterEach, describe, expect, it, vi } from "vitest";
import { validateUncataloguedExercise } from "../modules/workouts/exerciseAiFallback";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("uncatalogued exercise AI validation", () => {
  it("uses OpenRouter first and canonicalizes model muscle/equipment values", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    vi.stubEnv("OPENROUTER_MODEL", "test/model");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test-key");
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({
          valid: true,
          canonicalName: "Good Morning",
          primaryMuscle: "Hamstrings",
          secondaryMuscles: ["Glutes"],
          equipmentName: "barbell",
          confidence: 0.97,
          reason: "A recognized barbell hip hinge movement.",
        }) } }],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await validateUncataloguedExercise({
      exerciseName: "good morning",
      muscles: ["back", "hamstrings", "glutes"],
      equipment: ["Barbell", "Dumbbells"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(result).toMatchObject({
      valid: true,
      canonicalName: "Good Morning",
      primaryMuscle: "hamstrings",
      secondaryMuscles: ["glutes"],
      equipmentName: "Barbell",
      confidence: 0.97,
    });
  });

  it("rejects model outputs that cannot map to FitOS muscles and equipment", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test-key");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: JSON.stringify({
        valid: true,
        canonicalName: "Good Morning",
        primaryMuscle: "unknown muscle",
        secondaryMuscles: [],
        equipmentName: "unknown equipment",
        confidence: 0.99,
      }) }] }),
    })));

    const result = await validateUncataloguedExercise({
      exerciseName: "Good Morning",
      muscles: ["back", "hamstrings"],
      equipment: ["Barbell"],
    });

    expect(result).toMatchObject({ valid: false, confidence: 0.99 });
  });

  it("falls through to Anthropic when OpenRouter cannot validate the exercise", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test-key");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ valid: false, confidence: 0.9 }) } }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: [{ type: "text", text: JSON.stringify({
          valid: true,
          canonicalName: "Meadows Row",
          primaryMuscle: "back",
          secondaryMuscles: ["biceps"],
          equipmentName: "Dumbbells",
          confidence: 0.95,
        }) }] }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await validateUncataloguedExercise({
      exerciseName: "Meadows Row",
      muscles: ["back", "biceps"],
      equipment: ["Dumbbells"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.anthropic.com/v1/messages");
    expect(result).toMatchObject({ valid: true, canonicalName: "Meadows Row", primaryMuscle: "back" });
  });

  it("returns no result when no validation provider is configured", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    await expect(validateUncataloguedExercise({ exerciseName: "hate", muscles: ["back"], equipment: ["Dumbbells"] }))
      .resolves.toBeNull();
  });
});
