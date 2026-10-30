import { afterEach, describe, expect, it, vi } from "vitest";
import { getAiExerciseFallback, validateUncataloguedExercise } from "../modules/workouts/exerciseAiFallback";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("OpenRouter workout exercise generation", () => {
  it("keeps secondary biceps metadata without creating Biceps workout targets", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    vi.stubEnv("OPENROUTER_MODEL", "test/model");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({
          exercises: [
            { exercise: "Chest Supported Row", machine: "Dumbbells", muscle: "back", secondaryMuscles: ["biceps"], instructions: "Support chest on bench and row dumbbells toward hips.", sets: 3, repRangeLow: 8, repRangeHigh: 12 },
            { exercise: "Lat Pulldown", machine: "Cable Machine", muscle: "back", secondaryMuscles: ["biceps"], instructions: "Pull the bar to upper chest with control.", sets: 3, repRangeLow: 8, repRangeHigh: 12 },
            { exercise: "Seated Cable Row", machine: "Cable Machine", muscle: "back", secondaryMuscles: ["biceps"], instructions: "Keep torso stable and pull handle to waist.", sets: 3, repRangeLow: 8, repRangeHigh: 12 }
          ]
        }) } }]
      })
    })));

    const result = await getAiExerciseFallback({
      targetMuscles: ["back"],
      sessionDurationMinutes: 60,
      count: 3,
      equipment: [
        { name: "Dumbbells", aliases: [] },
        { name: "Cable Machine", aliases: ["Cable"] },
      ],
    });

    expect(result).toHaveLength(3);
    expect(result.every((exercise) => exercise.primaryMuscle === "back")).toBe(true);
    expect(result.every((exercise) => exercise.targetedMuscles.length === 1 && exercise.targetedMuscles[0] === "back")).toBe(true);
    expect(result.every((exercise) => exercise.muscleCategories.length === 1 && exercise.muscleCategories[0] === "back")).toBe(true);
    expect(result.every((exercise) => exercise.secondaryMuscles?.includes("biceps"))).toBe(true);
  });
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
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test-key");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        valid: true,
        canonicalName: "Good Morning",
        primaryMuscle: "unknown muscle",
        secondaryMuscles: [],
        equipmentName: "unknown equipment",
        confidence: 0.99,
      }) } }] }),
    })));

    const result = await validateUncataloguedExercise({
      exerciseName: "Good Morning",
      muscles: ["back", "hamstrings"],
      equipment: ["Barbell"],
    });

    expect(result).toMatchObject({ valid: false, confidence: 0.99 });
  });

  it("does not fall through to other providers when OpenRouter rejects an exercise", async () => {
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(result).toMatchObject({ valid: false, confidence: 0.9 });
  });

  it("returns no result when no validation provider is configured", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    await expect(validateUncataloguedExercise({ exerciseName: "hate", muscles: ["back"], equipment: ["Dumbbells"] }))
      .resolves.toBeNull();
  });
});
