import { afterEach, describe, expect, it, vi } from "vitest";
import { answerExerciseQuestion, buildExerciseAssistantMessages, isExerciseAssistantConfigured } from "../modules/exercises/exerciseAssistant";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("exercise assistant context", () => {
  it("binds the question to catalog muscles, equipment, and instructions", () => {
    const messages = buildExerciseAssistantMessages({
      name: "Seated Cable Row",
      primaryMuscle: "Lats",
      secondaryMuscles: ["Rhomboids", "Biceps"],
      equipment: ["Cable Machine"],
      instructions: "Sit upright and pull the handle toward your abdomen.",
      movementPattern: "horizontal_pull",
    }, "How should I breathe?");
    expect(messages.user).toContain("Seated Cable Row");
    expect(messages.user).toContain("Rhomboids");
    expect(messages.user).toContain("Cable Machine");
    expect(messages.user).toContain("Sit upright and pull the handle toward your abdomen.");
    expect(messages.user).toContain("How should I breathe?");
    expect(messages.system).toContain("Never mention catalogs, databases, APIs, providers, models");
    expect(messages.system).toContain("Do not write code or answer unrelated requests");
  });

  it("answers seated cable row breathing directly without an AI provider", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const answer = await answerExerciseQuestion({
      name: "Eccentric Emphasis Seated Cable Row", primaryMuscle: "Lats", secondaryMuscles: ["Rhomboids", "Biceps"],
      equipment: ["Cable Machine"], instructions: "", movementPattern: "csv_recommendation",
    }, "Breathing");
    expect(answer?.toLowerCase()).toContain("exhale as you pull the handle toward your torso");
    expect(answer?.toLowerCase()).toContain("inhale as you extend your arms back over about 3 seconds");
  });

  it("keeps unrelated requests out of the exercise assistant", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(answerExerciseQuestion({
      name: "Seated Cable Row", primaryMuscle: "Lats", secondaryMuscles: [], equipment: ["Cable Machine"], instructions: "",
    }, "Write a C++ program that prints hello world.")).resolves.toBe(
      "I can help with this exercise's technique, form, breathing, or alternatives."
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses only supplied substitution choices for alternative questions", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const answer = await answerExerciseQuestion({
      name: "Seated Cable Row", primaryMuscle: "Lats", secondaryMuscles: ["Rhomboids"],
      equipment: ["Cable Machine"], instructions: "", alternatives: [{ name: "Dumbbell Row", equipment: ["Dumbbells", "Bench"] }],
    }, "What are suitable alternatives?");
    expect(answer).toContain("Dumbbell Row");
    expect(answer).toContain("Dumbbells, Bench");
    expect(answer).not.toContain("Lat Pulldown");
  });

  it("does not expose internal catalog or provider limitations in model answers", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "openai-test-key");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "The catalog instructions are currently empty, so I can't provide details." } }] }),
    })));
      const answer = await answerExerciseQuestion({
      name: "Seated Cable Row", primaryMuscle: "Lats", secondaryMuscles: [], equipment: ["Cable Machine"],
      instructions: "Sit tall and pull the handle toward your abdomen.", movementPattern: "horizontal_pull",
      }, "What tempo should I use?");
      expect(answer).toContain("Sit tall and pull the handle toward your abdomen.");
      expect(answer).not.toContain("catalog");
  });

  it("reports when no server-side assistant provider is configured", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");

    expect(isExerciseAssistantConfigured()).toBe(false);
    await expect(answerExerciseQuestion({
      name: "Lat Pulldown", primaryMuscle: "Lats", secondaryMuscles: [], equipment: ["Cable Machine"], instructions: "",
    }, "How should I set up?")).resolves.toContain("For the Lat Pulldown");
  });

  it("uses the configured OpenAI provider and returns its exercise answer", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "openai-test-key");
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "Keep your torso steady." } }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    expect(isExerciseAssistantConfigured()).toBe(true);
    await expect(answerExerciseQuestion({
      name: "Lat Pulldown", primaryMuscle: "Lats", secondaryMuscles: [], equipment: ["Cable Machine"], instructions: "",
    }, "What tempo should I use?")).resolves.toBe("Keep your torso steady.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/chat/completions");
  });
});
