import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildExerciseInstructionFallback, isValidYouTubeVideoId, exerciseDemoEmbedUrl, findExerciseDemo } from "../modules/exercises/exerciseMedia";
import { parseExerciseCsv } from "../modules/workouts/exerciseCsvRepository";

describe("curated exercise demo matching", () => {
  it("matches canonical exercise metadata with normalized capitalization and spacing", () => {
    const latPulldown = findExerciseDemo("  LAT   PULLDOWN ", ["Cable Machine"]);
    const cableRow = findExerciseDemo("Seated Cable Row", ["Cable Machine"]);
    expect(latPulldown).toMatchObject({ kind: "video", title: "Lat Pull Down" });
    expect(latPulldown.instructions).toContain("Set up the   LAT   PULLDOWN");
    expect(cableRow).toMatchObject({ kind: "video", provider: "youtube" });
    expect(exerciseDemoEmbedUrl(cableRow))
      .toContain("youtube-nocookie.com/embed/xQNrFHEMhI4");
    expect(findExerciseDemo("Dumbbell Row", ["Dumbbell"])).toMatchObject({ kind: "video", sourceName: "Men's Health" });
    expect(findExerciseDemo("Lat Pulldown", ["Lat Pulldown Machine"]).kind).toBe("video");
  });

  it("uses written instructions rather than borrowing a different variation's video", () => {
    const wideRow = findExerciseDemo("Wide Grip Seated Cable Row", ["Cable Machine"], {
      primaryMuscle: "lats", movementPattern: "horizontal_pull",
    });
    const wrongEquipment = findExerciseDemo("Dumbbell Row", ["Cable Machine"]);
    const unknown = findExerciseDemo("Unknown Row", ["Dumbbell"]);
    expect(wideRow).toMatchObject({ kind: "instructions", title: "Wide Grip Seated Cable Row instructions" });
    expect(wideRow.instructions).toContain("pull the resistance toward your ribs");
    expect(wrongEquipment.kind).toBe("instructions");
    expect(unknown.instructions).toContain("Unknown Row");
    expect(exerciseDemoEmbedUrl(findExerciseDemo("Lat Pulldown", ["Cable Machine"])))
      .toContain("youtube-nocookie.com/embed/iKrKgWR9wbY");
  });

  it("prefers stored instructions and builds contextual guidance when the catalogue text is empty", () => {
    expect(buildExerciseInstructionFallback("Bent Over Row", ["Barbell"], {
      instructions: "Hinge at your hips and row the bar to your lower ribs.", movementPattern: "horizontal_pull",
    })).toBe("Hinge at your hips and row the bar to your lower ribs.");
    expect(buildExerciseInstructionFallback("Cable Hammer Curl", ["Cable Machine"], {
      primaryMuscle: "biceps", movementPattern: "elbow_flexion",
    })).toContain("Keep your upper arms steady, flex your elbows");
  });

  it("rejects malformed YouTube IDs before constructing an embed", () => {
    expect(isValidYouTubeVideoId("iKrKgWR9wbY")).toBe(true);
    expect(isValidYouTubeVideoId("not-a-video-id")).toBe(false);
    expect(exerciseDemoEmbedUrl({
      kind: "video", provider: "youtube", videoId: "invalid", title: "Wrong ID", sourceName: "test",
      sourceUrl: "https://youtube.com/", thumbnailUrl: "https://example.test/thumb.jpg",
    })).toBeNull();
  });

  it("provides media for every catalog name/equipment pair without inventing IDs", () => {
    const catalogPath = path.resolve(__dirname, "../../data/exercises.csv");
    const catalog = parseExerciseCsv(fs.readFileSync(catalogPath, "utf8"));
    const pairs = new Map(catalog.map((exercise) => [`${exercise.exercise}\u0000${exercise.machine}`, exercise]));
    const coverage = [...pairs.values()].map((exercise) => findExerciseDemo(exercise.exercise, [exercise.machine]));
    const videos = coverage.filter((demo) => demo.kind === "video");
    const instructions = coverage.filter((demo) => demo.kind === "instructions");

    expect(coverage).toHaveLength(pairs.size);
    expect(videos).toHaveLength(5);
    expect(instructions).toHaveLength(pairs.size - videos.length);
    expect(instructions.every((demo) => demo.instructions?.length)).toBe(true);
    expect(new Set(videos.map((demo) => demo.videoId)).size).toBe(4);
  });

  it("keeps media responsive and renders written instructions when a video is unavailable", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "../../../frontend/styles.css"), "utf8");
    const app = fs.readFileSync(path.resolve(__dirname, "../../../frontend/app.js"), "utf8");
    expect(css).toContain(".workout-exercise-support { grid-column: 2 / 4");
    expect(css).toContain(".exercise-demo-preview { position: relative");
    expect(css).toContain(".exercise-demo-fallback");
    expect(css).toContain("aspect-ratio: 16 / 9");
    expect(css).toContain(".exercise-demo-player iframe { display: block; width: 100%; height: 100%");
    expect(app).toContain('playerVars: { autoplay: 0');
    expect(app).toContain('onError: () =>');
    expect(app).toContain("showUnavailableExerciseDemo(player, exercise, demo)");
    expect(app).toContain("https://www.youtube.com/iframe_api");
    expect(app).toContain('demo.kind === "video"');
    expect(app).toContain("exerciseDemoInstructions(exercise, demo)");
    expect(app).not.toContain("Find an exact demonstration");
    expect(app).not.toContain("youtube.com/results?search_query");
    expect(app).not.toContain("Open on YouTube");
    expect(app).not.toContain("Search YouTube for");
    expect(app).toContain('image.addEventListener("error"');
    expect(app).toContain('fallback.textContent = "Video preview unavailable"');
  });
});
