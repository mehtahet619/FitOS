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
    expect(messages.system).toContain("Do not invent equipment, catalog instructions, video links");
  });

  it("reports when no server-side assistant provider is configured", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");

    expect(isExerciseAssistantConfigured()).toBe(false);
    await expect(answerExerciseQuestion({
      name: "Lat Pulldown", primaryMuscle: "Lats", secondaryMuscles: [], equipment: ["Cable Machine"], instructions: "",
    }, "How should I set up?")).resolves.toBeNull();
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
    }, "How should I set up?")).resolves.toBe("Keep your torso steady.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/chat/completions");
  });
});
