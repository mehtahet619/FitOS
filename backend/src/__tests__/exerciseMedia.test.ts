import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isValidYouTubeVideoId, exerciseDemoEmbedUrl, findExerciseDemo } from "../modules/exercises/exerciseMedia";
import { parseExerciseCsv } from "../modules/workouts/exerciseCsvRepository";

describe("curated exercise demo matching", () => {
  it("matches canonical exercise metadata with normalized capitalization and spacing", () => {
    const latPulldown = findExerciseDemo("  LAT   PULLDOWN ", ["Cable Machine"]);
    const cableRow = findExerciseDemo("Seated Cable Row", ["Cable Machine"]);
    expect(latPulldown).toMatchObject({ kind: "video", title: "Lat Pull Down" });
    expect(cableRow).toMatchObject({ kind: "video", provider: "youtube" });
    expect(exerciseDemoEmbedUrl(cableRow))
      .toContain("youtube-nocookie.com/embed/xQNrFHEMhI4");
    expect(findExerciseDemo("Dumbbell Row", ["Dumbbell"])).toMatchObject({ kind: "video", sourceName: "Men's Health" });
    expect(findExerciseDemo("Lat Pulldown", ["Lat Pulldown Machine"]).kind).toBe("video");
  });

  it("uses exact-name search links rather than borrowing a different variation's video", () => {
    const wideRow = findExerciseDemo("Wide Grip Seated Cable Row", ["Cable Machine"]);
    const wrongEquipment = findExerciseDemo("Dumbbell Row", ["Cable Machine"]);
    const unknown = findExerciseDemo("Unknown Row", ["Dumbbell"]);
    expect(wideRow.kind).toBe("search");
    expect(wideRow.searchQuery).toBe("Wide Grip Seated Cable Row Cable Machine proper form demonstration");
    expect(new URL(wideRow.searchUrl).searchParams.get("search_query")).toBe(wideRow.searchQuery);
    expect(wrongEquipment).toMatchObject({ kind: "search", searchQuery: "Dumbbell Row Cable Machine proper form demonstration" });
    expect(unknown).toMatchObject({ kind: "search", searchQuery: "Unknown Row Dumbbell proper form demonstration" });
    expect(exerciseDemoEmbedUrl(findExerciseDemo("Lat Pulldown", ["Cable Machine"])))
      .toContain("youtube-nocookie.com/embed/iKrKgWR9wbY");
  });

  it("rejects malformed YouTube IDs before constructing an embed", () => {
    expect(isValidYouTubeVideoId("iKrKgWR9wbY")).toBe(true);
    expect(isValidYouTubeVideoId("not-a-video-id")).toBe(false);
    expect(exerciseDemoEmbedUrl({
      kind: "video", provider: "youtube", videoId: "invalid", title: "Wrong ID", sourceName: "test",
      sourceUrl: "https://youtube.com/", searchQuery: "Wrong ID proper form demonstration", searchUrl: "https://youtube.com/",
    })).toBeNull();
  });

  it("provides media for every catalog name/equipment pair without inventing IDs", () => {
    const catalogPath = path.resolve(__dirname, "../../data/exercises.csv");
    const catalog = parseExerciseCsv(fs.readFileSync(catalogPath, "utf8"));
    const pairs = new Map(catalog.map((exercise) => [`${exercise.exercise}\u0000${exercise.machine}`, exercise]));
    const coverage = [...pairs.values()].map((exercise) => findExerciseDemo(exercise.exercise, [exercise.machine]));
    const videos = coverage.filter((demo) => demo.kind === "video");
    const searches = coverage.filter((demo) => demo.kind === "search");

    expect(coverage).toHaveLength(pairs.size);
    expect(videos).toHaveLength(5);
    expect(searches).toHaveLength(pairs.size - videos.length);
    expect(new Set(videos.map((demo) => demo.videoId)).size).toBe(4);
  });

  it("keeps media responsive and falls back to search when a video is unavailable", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "../../../frontend/styles.css"), "utf8");
    const app = fs.readFileSync(path.resolve(__dirname, "../../../frontend/app.js"), "utf8");
    expect(css).toContain(".workout-exercise-support { grid-column: 2 / 4");
    expect(css).toContain(".exercise-demo-preview { position: relative");
    expect(css).toContain(".exercise-demo-search { display: grid");
    expect(css).toContain("aspect-ratio: 16 / 9");
    expect(css).toContain(".exercise-demo-player iframe { display: block; width: 100%; height: 100%");
    expect(app).toContain('playerVars: { autoplay: 0');
    expect(app).toContain('onError: () =>');
    expect(app).toContain("showUnavailableExerciseDemo(player, demo, exercise.exerciseName)");
    expect(app).toContain('link.textContent = `Search YouTube for ${exerciseName}`');
    expect(app).toContain("https://www.youtube.com/iframe_api");
    expect(app).toContain('image.addEventListener("error"');
    expect(app).toContain('fallback.textContent = "Video preview unavailable"');
  });
});
