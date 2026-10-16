import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * Behavioural tests for the live form coaching in frontend/vision.js.
 *
 * vision.js is a browser ES module (it imports MediaPipe from a CDN), so the
 * coaching section is extracted and evaluated against a stubbed DOM. This
 * exercises the real landmark geometry and the per-frame `processExercise`
 * pipeline without pulling in the pose model.
 */

const VISION_SOURCE = fs.readFileSync(path.resolve(__dirname, "../../../frontend/vision.js"), "utf8");

interface StubNode {
  id: string;
  textContent: string;
  innerHTML: string;
  style: Record<string, string>;
}

interface VisionModule {
  EXERCISE_CONFIG: Record<string, {
    label: string;
    required: number[][];
    angleOf: (lm: unknown[]) => number;
    feedback: (angle: number, phase: string, lm: unknown[]) => string;
  }>;
  VisionCoach: {
    currentExercise: string;
    phase: string;
    repCount: number;
    comparison: Record<string, any>;
    processExercise: (lm: unknown[]) => void;
    renderComparisonResults: (analysis: unknown) => void;
    refreshComparisonStatus: (manual: boolean) => Promise<void>;
    resetReps: () => void;
  };
}

function makeDocument() {
  const nodes = new Map<string, StubNode>();
  const documentStub = {
    getElementById: (id: string): StubNode => {
      let node = nodes.get(id);
      if (!node) {
        node = { id, textContent: "", innerHTML: "", style: {} };
        nodes.set(id, node);
      }
      return node;
    },
    querySelectorAll: () => [],
  };
  return { documentStub, nodes };
}

function loadModule(documentStub: unknown, apiStub: unknown) {
  const start = VISION_SOURCE.indexOf("const LANDMARK = {");
  const end = VISION_SOURCE.indexOf('window.addEventListener("DOMContentLoaded"');
  if (start < 0 || end <= start) {
    throw new Error("Could not locate the coaching section in frontend/vision.js");
  }
  const body = `${VISION_SOURCE.slice(start, end)}
return {
  EXERCISE_CONFIG: EXERCISE_CONFIG,
  VisionCoach: VisionCoach,
  angleBetween: angleBetween,
  hasVisiblePose: hasVisiblePose,
  tiltFromVertical: tiltFromVertical,
  torsoLineOffset: torsoLineOffset,
};`;
  const factory = new Function("window", "document", "Api", "performance", "requestAnimationFrame", body) as (
    window: unknown, document: unknown, api: unknown, performance: unknown, raf: unknown,
  ) => VisionModule;
  const windowStub = { addEventListener: () => {}, setTimeout: () => 0, clearTimeout: () => {} };
  return factory(windowStub, documentStub, apiStub, { now: () => 0 }, () => 0);
}

const SHOULDER_L = 11;
const SHOULDER_R = 12;
const ELBOW_L = 13;
const ELBOW_R = 14;
const WRIST_L = 15;
const WRIST_R = 16;
const HIP_L = 23;
const HIP_R = 24;
const ANKLE_L = 27;
const ANKLE_R = 28;

/** Builds a 33-entry landmark array; unspecified points are placed mid-frame and visible. */
function pose(points: Record<number, { x: number; y: number; visibility?: number }>) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  for (const [index, point] of Object.entries(points)) {
    lm[Number(index)] = { x: point.x, y: point.y, z: 0, visibility: point.visibility ?? 1 };
  }
  return lm;
}

/** Both sides of a joint, to feed the "at least one side visible" check. */
function both(indices: number[], x: number, y: number, visibility = 1) {
  const out: Record<number, { x: number; y: number; visibility: number }> = {};
  indices.forEach((index) => {
    out[index] = { x, y, visibility };
  });
  return out;
}

const SHOULDERS = [SHOULDER_L, SHOULDER_R];
const ELBOWS = [ELBOW_L, ELBOW_R];
const WRISTS = [WRIST_L, WRIST_R];
const HIPS = [HIP_L, HIP_R];
const ANKLES = [ANKLE_L, ANKLE_R];

describe("vision live form coaching", () => {
  let nodes: Map<string, StubNode>;
  let module: VisionModule;

  beforeEach(() => {
    const built = makeDocument();
    nodes = built.nodes;
    module = loadModule(built.documentStub, { get: async () => ({ configured: true, available: true }) });
    module.VisionCoach.currentExercise = "curl";
    module.VisionCoach.phase = "down";
    module.VisionCoach.repCount = 0;
    module.VisionCoach.comparison.capturing = false;
  });

  const feedbackText = () => nodes.get("camera-feedback")?.textContent;

  describe("exercise-specific rules (inferable from landmarks)", () => {
    it("coaches elbow drift away from the torso for a curl", () => {
      const lm = pose({
        ...both(SHOULDERS, 0.5, 0.3),
        ...both(ELBOWS, 0.72, 0.5), // drifted laterally off the torso line
        ...both(WRISTS, 0.9, 0.5),
        ...both(HIPS, 0.5, 0.7),
      });
      expect(module.EXERCISE_CONFIG.curl.feedback(90, "down", lm)).toBe("Keep your elbows close to your torso");
    });

    it("coaches upper-body swing when the torso leaves vertical", () => {
      const lm = pose({
        ...both(SHOULDERS, 0.5, 0.3),
        ...both(ELBOWS, 0.5, 0.5),
        ...both(WRISTS, 0.5, 0.9),
        ...both(HIPS, 0.78, 0.7), // torso tipped ~34 degrees from vertical
      });
      expect(module.EXERCISE_CONFIG.curl.feedback(120, "down", lm)).toBe("Avoid swinging your upper body");
    });

    it("coaches range of motion with an upright, tucked torso", () => {
      const lm = pose({
        ...both(SHOULDERS, 0.5, 0.3),
        ...both(ELBOWS, 0.5, 0.5),
        ...both(WRISTS, 0.65, 0.62),
        ...both(HIPS, 0.5, 0.7),
      });
      expect(module.EXERCISE_CONFIG.curl.feedback(129, "down", lm)).toBe("Curl a bit higher — full range of motion");
    });

    it("separates hip sagging from piking in a push-up", () => {
      const base = {
        ...both(SHOULDERS, 0.7, 0.5),
        ...both(ELBOWS, 0.5, 0.55),
        ...both(WRISTS, 0.25, 0.52),
        ...both(ANKLES, 0.15, 0.45),
      };
      const sagging = pose({ ...base, ...both(HIPS, 0.4, 0.58) }); // hips below the shoulder -> ankle line
      const piking = pose({ ...base, ...both(HIPS, 0.4, 0.4) });   // hips above the line
      expect(module.EXERCISE_CONFIG.pushup.feedback(150, "up", sagging)).toBe("Keep your hips up — avoid sagging");
      expect(module.EXERCISE_CONFIG.pushup.feedback(150, "up", piking)).toBe("Lower your hips — avoid piking");
    });
  });

  describe("per-frame updates during the movement", () => {
    it("changes the visible cue mid-repetition, before the rep completes", () => {
      module.VisionCoach.processExercise(pose({
        ...both(SHOULDERS, 0.5, 0.3),
        ...both(ELBOWS, 0.72, 0.5),
        ...both(WRISTS, 0.9, 0.5),
        ...both(HIPS, 0.5, 0.7),
      }));
      expect(feedbackText()).toBe("Keep your elbows close to your torso");
      expect(module.VisionCoach.phase).toBe("down");
      expect(module.VisionCoach.repCount).toBe(0);

      module.VisionCoach.processExercise(pose({
        ...both(SHOULDERS, 0.5, 0.3),
        ...both(ELBOWS, 0.5, 0.5),
        ...both(WRISTS, 0.65, 0.62),
        ...both(HIPS, 0.5, 0.7),
      }));
      expect(feedbackText()).toBe("Curl a bit higher — full range of motion");
      // Still mid-rep: no completion, no score, cue already updated.
      expect(module.VisionCoach.phase).toBe("down");
      expect(module.VisionCoach.repCount).toBe(0);
    });
  });

  describe("degraded inputs", () => {
    it("asks the user to reposition when landmarks are not visible", () => {
      module.VisionCoach.processExercise(pose({
        ...both(SHOULDERS, 0.5, 0.3, 0.1),
        ...both(ELBOWS, 0.5, 0.5, 0.1),
        ...both(WRISTS, 0.65, 0.62, 0.1),
        ...both(HIPS, 0.5, 0.7, 0.1),
      }));
      expect(feedbackText()).toBe("Move fully into frame so your body is clearly visible.");
      expect(module.VisionCoach.repCount).toBe(0);
    });

    it("does not throw when the pose disappears (camera / detection loss)", () => {
      expect(() => module.VisionCoach.processExercise([])).not.toThrow();
      expect(feedbackText()).toBe("Move fully into frame so your body is clearly visible.");
    });

    it("routes an unsupported exercise to the shared coach without inventing a specific correction", () => {
      module.VisionCoach.currentExercise = "burpee";
      expect(() => module.VisionCoach.processExercise(pose({}))).not.toThrow();
      expect(feedbackText()).toBe(
        "Analyzing this exercise with the shared coach. Keep your full body visible and move at a controlled pace",
      );
    });
  });

  describe("comparison result labelling", () => {
    it("labels a score against the user's baseline, never the demonstration", () => {
      module.VisionCoach.renderComparisonResults({
        formScorePercent: 82,
        confidence: 0.9,
        summary: "Solid repetition.",
        differences: [],
        corrections: [],
      });
      const html = nodes.get("form-comparison-results")?.innerHTML ?? "";
      expect(html).toContain("baseline repetition");
      expect(html.toLowerCase()).not.toContain("demonstration");
    });
  });

  describe("comparison service availability", () => {
    it("shows the temporary-unavailable message and a retry when the service fails", async () => {
      const built = makeDocument();
      const failing = loadModule(built.documentStub, { get: async () => { throw new Error("down"); } });
      failing.VisionCoach.currentExercise = "curl";

      await failing.VisionCoach.refreshComparisonStatus(false);

      const status = built.nodes.get("form-comparison-status")?.textContent ?? "";
      expect(status).toContain("temporarily unavailable");
      expect(built.nodes.get("form-comparison-retry-btn")?.style.display).toBe("inline-flex");
      expect(built.nodes.get("form-comparison-results")?.innerHTML).toBe("");
    });

    it("invites a baseline repetition when the service is available", async () => {
      await module.VisionCoach.refreshComparisonStatus(false);
      expect(nodes.get("form-comparison-status")?.textContent).toBe(
        "Curl: complete one repetition to set your baseline.",
      );
      expect(nodes.get("form-comparison-retry-btn")?.style.display).toBe("none");
    });
  });
});
