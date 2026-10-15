import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildExerciseVideoQuery,
  clearExerciseVideoCache,
  createYouTubeVideoProvider,
  invalidateExerciseVideo,
  resolveExerciseVideo,
  scoreExerciseVideo,
  selectRelevantVideo,
  setVideoSearchProviderForTests,
} from "../modules/exercises/exerciseVideoProvider";
import type { ExerciseVideoCandidate, ExerciseVideoProvider, ExerciseVideoQuery } from "../modules/exercises/exerciseVideoProvider";

function candidate(overrides: Partial<ExerciseVideoCandidate> = {}): ExerciseVideoCandidate {
  return {
    videoId: "abcDEF12345",
    title: "Barbell Bench Press: Proper Form and Technique",
    channelTitle: "NASM",
    thumbnailUrl: "https://i.ytimg.com/vi/abcDEF12345/hqdefault.jpg",
    watchUrl: "https://www.youtube.com/watch?v=abcDEF12345",
    durationSeconds: 120,
    embeddable: true,
    ...overrides,
  };
}

function stubProvider(candidates: readonly ExerciseVideoCandidate[]): ExerciseVideoProvider {
  return { name: "stub", configured: true, search: async () => [...candidates] };
}

const benchPress: ExerciseVideoQuery = {
  exerciseId: "ex-bench",
  name: "Bench Press",
  equipment: ["Barbell"],
  primaryMuscle: "Chest",
  movementPattern: "horizontal_push",
};

const cableRow: ExerciseVideoQuery = {
  exerciseId: "ex-cable-row",
  name: "Seated Cable Row",
  equipment: ["Cable Machine"],
  primaryMuscle: "Lats",
  movementPattern: "horizontal_pull",
};

// A name that intentionally has no curated entry, so resolution exercises the
// dynamic search provider, cache, and fallback paths.
const inclinePress: ExerciseVideoQuery = {
  exerciseId: "ex-incline",
  name: "Incline Bench Press",
  equipment: ["Barbell"],
  primaryMuscle: "Chest",
  movementPattern: "horizontal_push",
};

beforeEach(() => {
  clearExerciseVideoCache();
  setVideoSearchProviderForTests(undefined);
});

describe("exercise video query building", () => {
  it("prepends the equipment when the name does not already include it", () => {
    expect(buildExerciseVideoQuery(benchPress)).toBe("Barbell Bench Press proper form demonstration");
    expect(buildExerciseVideoQuery({ name: "Barbell Bench Press", equipment: ["Barbell"] }))
      .toBe("Barbell Bench Press proper form demonstration");
    expect(buildExerciseVideoQuery({ name: "Push-Up", equipment: ["Bodyweight"] }))
      .toBe("Push-Up proper form demonstration");
  });
});

describe("exercise video relevance", () => {
  it("never accepts a different movement family", () => {
    const rowVideo = candidate({ title: "How to do a Seated Cable Row", channelTitle: "Bodybuilding.com" });
    expect(scoreExerciseVideo(benchPress, rowVideo)).toBeNull();
    const benchVideo = candidate({ title: "Barbell Bench Press proper form" });
    expect(scoreExerciseVideo(cableRow, benchVideo)).toBeNull();
  });

  it("rejects conflicting equipment and non-embeddable or malformed videos", () => {
    expect(scoreExerciseVideo({ name: "Dumbbell Row", equipment: ["Dumbbell"] }, candidate({ title: "Barbell Bent Over Row tutorial" }))).toBeNull();
    expect(scoreExerciseVideo(benchPress, candidate({ embeddable: false }))).toBeNull();
    expect(scoreExerciseVideo(benchPress, candidate({ videoId: "too-short" }))).toBeNull();
  });

  it("accepts a matching video and prefers the highest scoring candidate", () => {
    const weak = candidate({ videoId: "weakWEAK111", title: "Bench press", channelTitle: "Random", durationSeconds: 1500 });
    const strong = candidate({ videoId: "strongGOOD1", title: "Barbell Bench Press: Proper Form and Technique", channelTitle: "NASM" });
    const selected = selectRelevantVideo(benchPress, [weak, strong]);
    expect(selected?.videoId).toBe("strongGOOD1");
  });

  it("skips excluded video ids when selecting", () => {
    const video = candidate({ videoId: "strongGOOD1" });
    expect(selectRelevantVideo(benchPress, [video], new Set(["strongGOOD1"]))).toBeNull();
  });
});

describe("exercise video resolution and caching", () => {
  it("serves the verified catalogue when no search API is configured", async () => {
    setVideoSearchProviderForTests(null);
    const resolved = await resolveExerciseVideo(benchPress);
    expect(resolved.source).toBe("fitos-curated");
    expect(resolved.demo).toMatchObject({ kind: "video", videoId: "CayG6UYqL8g" });
  });

  it("caches a resolved video and only searches once", async () => {
    const search = vi.fn(async () => [candidate()]);
    setVideoSearchProviderForTests({ name: "stub", configured: true, search });
    const first = await resolveExerciseVideo({ ...inclinePress, exerciseId: "ex-cache" });
    const second = await resolveExerciseVideo({ ...inclinePress, exerciseId: "ex-cache" });
    expect(first.source).toBe("youtube-data-api");
    expect(second.source).toBe("cache");
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("re-resolves after invalidation and when the cached video is excluded", async () => {
    setVideoSearchProviderForTests(stubProvider([
      candidate({ videoId: "firstVIDEO1", title: "Incline Bench Press: Proper Form and Technique", channelTitle: "NASM" }),
      candidate({ videoId: "secondVIDE2", title: "Barbell Bench Press proper form demonstration", channelTitle: "BarBend" }),
    ]));
    const query: ExerciseVideoQuery = { ...inclinePress, exerciseId: "ex-refresh" };
    const first = await resolveExerciseVideo(query);
    expect(first.demo.videoId).toBe("firstVIDEO1");

    invalidateExerciseVideo(query, "firstVIDEO1");
    const refreshed = await resolveExerciseVideo(query, { refresh: true, excludeVideoIds: ["firstVIDEO1"] });
    expect(refreshed.demo.videoId).toBe("secondVIDE2");
  });

  it("falls back to written instructions when nothing relevant is embeddable", async () => {
    setVideoSearchProviderForTests(stubProvider([candidate({ title: "Seated Cable Row tutorial", channelTitle: "Random" })]));
    const resolved = await resolveExerciseVideo({ ...inclinePress, exerciseId: "ex-none" });
    expect(resolved.source).toBe("none");
    expect(resolved.demo.kind).toBe("instructions");
    expect(resolved.demo.instructions?.length).toBeGreaterThan(0);
  });
});

describe("YouTube Data API provider", () => {
  it("confirms embeddability and duration from videos.list", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/search")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: [{ id: { videoId: "abcDEF12345" }, snippet: { title: "Bench Press", channelTitle: "NASM" } }] }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [{
            id: "abcDEF12345",
            snippet: { title: "Barbell Bench Press", channelTitle: "NASM", thumbnails: { medium: { url: "https://i.ytimg.com/vi/abcDEF12345/mqdefault.jpg" } } },
            contentDetails: { duration: "PT4M13S" },
            status: { embeddable: true },
          }],
        }),
      };
    });
    const provider = createYouTubeVideoProvider({ apiKey: "server-side-key", fetchImpl: fetchImpl as never });
    const results = await provider.search("Barbell Bench Press proper form demonstration", 5);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ videoId: "abcDEF12345", embeddable: true, durationSeconds: 253 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // The key must never be part of the payload returned to callers.
    expect(JSON.stringify(results)).not.toContain("server-side-key");
  });
});
