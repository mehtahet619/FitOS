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
  setFrameAspect: (w: number, h: number) => void;
  coachKeyFor: (name: string, movementPattern?: string) => string | null;
  classifyExercise: (name: string, movementPattern?: string) => { key: string | null; kind: string; reason: string };
  bestSide: (lm: unknown[], groups: number[][]) => number;
  angleBetween: (a: unknown, b: unknown, c: unknown) => number;
  VisionCoach: {
    [key: string]: any;
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
    createElement: () => ({ getContext: () => ({ drawImage: () => {} }), toDataURL: () => "data:image/jpeg;base64,AA" }),
    hidden: false,
  };
  return { documentStub, nodes };
}

const clock = { t: 0 };
const rafCalls = { count: 0 };

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
  setFrameAspect: setFrameAspect,
  coachKeyFor: coachKeyFor,
  classifyExercise: classifyExercise,
  bestSide: bestSide,
  hasVisiblePose: hasVisiblePose,
  tiltFromVertical: tiltFromVertical,
  torsoLineOffset: torsoLineOffset,
};`;
  const factory = new Function("window", "document", "Api", "performance", "requestAnimationFrame", body) as (
    window: unknown, document: unknown, api: unknown, performance: unknown, raf: unknown,
  ) => VisionModule;
  const windowStub = { addEventListener: () => {}, setTimeout: () => 0, clearTimeout: () => {} };
  return factory(windowStub, documentStub, apiStub, { now: () => clock.t }, () => { rafCalls.count += 1; return 0; });
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

describe("catalogue-wide exercise classification", () => {
  let module: VisionModule;
  beforeEach(() => {
    const built = makeDocument();
    module = loadModule(built.documentStub, { get: async () => ({ configured: true, available: true }) });
  });

  it.each([
    ["Dumbbell Bench Press", "pressHorizontal"],
    ["Overhead Shoulder Press", "pressVertical"],
    ["Lat Pulldown", "pullVertical"],
    ["Leg Press", "legPress"],
    ["Leg Extension", "legExtension"],
    ["Hamstring Curl", "legCurl"],
    ["Lateral Raise", "lateralRaise"],
    ["Romanian Deadlift", "hinge"],
    ["Hip Thrust", "hipThrust"],
    ["Plank", "plank"],
  ])("classifies %s as %s", (name, key) => {
    expect(module.coachKeyFor(name)).toBe(key);
    expect(module.EXERCISE_CONFIG[key]).toBeDefined();
  });

  it("uses the catalogue movement pattern when a name is not recognized", () => {
    expect(module.coachKeyFor("New Catalogue Press Variant", "horizontal_push")).toBe("pressHorizontal");
  });

  it("does not claim reliable rep counting for cardio or complex movements", () => {
    const burpee = module.classifyExercise("Turkish Get-Up");
    const treadmill = module.classifyExercise("Treadmill Run");
    expect(burpee.kind).toBe("tracking");
    expect(burpee.key).toBeNull();
    expect(burpee.reason).toMatch(/2D camera/i);
    expect(treadmill.kind).toBe("tracking");
    expect(treadmill.reason).toMatch(/Cardio/i);
  });
});

describe("vision live form coaching", () => {
  let nodes: Map<string, StubNode>;
  let module: VisionModule;

  beforeEach(() => {
    clock.t = 0;
    rafCalls.count = 0;
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
    it("changes the visible cue mid-repetition once the new cue is sustained, before the rep completes", () => {
      const drift = pose({
        ...both(SHOULDERS, 0.5, 0.3),
        ...both(ELBOWS, 0.72, 0.5),
        ...both(WRISTS, 0.9, 0.5),
        ...both(HIPS, 0.5, 0.7),
      });
      const shallow = pose({
        ...both(SHOULDERS, 0.5, 0.3),
        ...both(ELBOWS, 0.5, 0.5),
        ...both(WRISTS, 0.65, 0.62),
        ...both(HIPS, 0.5, 0.7),
      });
      module.VisionCoach.processExercise(drift);
      expect(feedbackText()).toBe("Keep your elbows close to your torso");

      // A single different frame must not flip the text (flicker protection).
      clock.t += 2000;
      module.VisionCoach.processExercise(shallow);
      expect(feedbackText()).toBe("Keep your elbows close to your torso");

      for (let i = 0; i < 4; i += 1) { clock.t += 100; module.VisionCoach.processExercise(shallow); }
      expect(feedbackText()).toBe("Curl a bit higher — full range of motion");
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
      expect(feedbackText()).toBe(
        "Keep one shoulder, elbow, wrist and hip visible. Turn slightly sideways and improve lighting if needed.",
      );
      expect(module.VisionCoach.repCount).toBe(0);
    });

    it("does not throw when the pose disappears (camera / detection loss)", () => {
      expect(() => module.VisionCoach.processExercise([])).not.toThrow();
      expect(feedbackText()).toBe(
        "Keep one shoulder, elbow, wrist and hip visible. Turn slightly sideways and improve lighting if needed.",
      );
    });

    it("routes an unsupported exercise to the shared coach without inventing a specific correction", () => {
      module.VisionCoach.currentExercise = "burpee";
      expect(() => module.VisionCoach.processExercise(pose({}))).not.toThrow();
      expect(feedbackText()).toBe(
        "Analyzing this exercise with the shared coach. Keep your full body visible and move at a controlled pace.",
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

/** Elbow at (0.5,0.5), shoulder straight above; wrist placed so the elbow angle equals `deg`. */
function armPose(deg: number, extra: Record<number, { x: number; y: number; visibility?: number }> = {}) {
  const r = (deg * Math.PI) / 180;
  return pose({
    ...both(SHOULDERS, 0.5, 0.3),
    ...both(ELBOWS, 0.5, 0.5),
    ...both(WRISTS, 0.5 + 0.2 * Math.sin(r), 0.5 - 0.2 * Math.cos(r)),
    ...both(HIPS, 0.5, 0.7),
    ...extra,
  });
}

describe("vision pipeline: rep counting and robustness (synthetic landmark sequences)", () => {
  let module: VisionModule;
  let nodes: Map<string, StubNode>;
  const feed = (angles: number[]) => angles.forEach((a) => module.VisionCoach.processExercise(armPose(a)));
  /** Linear ramp of `n` frames, roughly what ~0.3s of real 30fps movement looks like. */
  const ramp = (from: number, to: number, n: number) =>
    Array.from({ length: n }, (_, i) => from + ((to - from) * (i + 1)) / n);
  const hold = (angle: number, n: number) => Array.from({ length: n }, () => angle);
  const fullRep = () => [...ramp(170, 40, 10), ...hold(40, 5), ...ramp(40, 170, 10), ...hold(170, 5)];

  beforeEach(() => {
    clock.t = 0;
    rafCalls.count = 0;
    const built = makeDocument();
    nodes = built.nodes;
    module = loadModule(built.documentStub, { get: async () => ({}) });
    module.VisionCoach.currentExercise = "curl";
    module.VisionCoach.comparison.unsupported = true; // no network in unit tests
    module.VisionCoach.resetReps();
  });

  it("counts one rep per complete extend -> curl -> extend cycle, and updates the angle readout", () => {
    feed(hold(170, 5));
    feed(fullRep());
    expect(module.VisionCoach.repCount).toBe(1);
    feed(fullRep());
    expect(module.VisionCoach.repCount).toBe(2);
    expect(nodes.get("vision-reps")?.textContent).toBe("2");
    expect(nodes.get("vision-angle")?.textContent).toMatch(/^\d+ deg$/);
  });

  it("does not count a half repetition that never reaches the bottom threshold", () => {
    feed([...hold(170, 5), ...ramp(170, 90, 10), ...hold(90, 5), ...ramp(90, 170, 10), ...hold(170, 5)]);
    expect(module.VisionCoach.repCount).toBe(0);
  });

  it("ignores a single noisy frame", () => {
    feed([...hold(170, 6), 20, ...hold(170, 6)]);
    expect(module.VisionCoach.repCount).toBe(0);
    expect(module.VisionCoach.phase).toBe("up");
  });

  it("keeps a rep in progress across a brief occlusion instead of resetting the state", () => {
    feed([...hold(170, 5), ...ramp(170, 40, 10), ...hold(40, 6)]);
    expect(module.VisionCoach.phase).toBe("down");
    const hidden = pose({ ...both(SHOULDERS, 0.5, 0.3, 0.05), ...both(ELBOWS, 0.5, 0.5, 0.05), ...both(WRISTS, 0.5, 0.7, 0.05), ...both(HIPS, 0.5, 0.7, 0.05) });
    module.VisionCoach.processExercise(hidden);
    expect(module.VisionCoach.phase).toBe("down");
    feed([...ramp(40, 170, 10), ...hold(170, 5)]);
    expect(module.VisionCoach.repCount).toBe(1);
  });

  it("measures the same true angle on a 16:9 frame once the aspect ratio is applied", () => {
    // Pixel-space 45 degree angle in a 1280x720 frame, converted to normalised coordinates.
    const shoulder = { x: 500 / 1280, y: 300 / 720 };
    const elbow = { x: 500 / 1280, y: 500 / 720 };
    const wrist = { x: 700 / 1280, y: 300 / 720 };
    module.setFrameAspect(1, 1);
    const distorted = module.angleBetween(shoulder, elbow, wrist);
    module.setFrameAspect(1280, 720);
    const corrected = module.angleBetween(shoulder, elbow, wrist);
    expect(Math.abs(distorted - 45)).toBeGreaterThan(10);
    expect(corrected).toBeCloseTo(45, 1);
  });

  it("takes every joint of one angle from the same body side", () => {
    const lm = pose({
      [SHOULDER_L]: { x: 0.5, y: 0.3, visibility: 0.9 }, [ELBOW_L]: { x: 0.5, y: 0.5, visibility: 0.9 }, [WRIST_L]: { x: 0.7, y: 0.5, visibility: 0.9 },
      [SHOULDER_R]: { x: 0.1, y: 0.1, visibility: 0.5 }, [ELBOW_R]: { x: 0.9, y: 0.9, visibility: 0.5 }, [WRIST_R]: { x: 0.1, y: 0.9, visibility: 0.5 },
      ...both(HIPS, 0.5, 0.7),
    });
    expect(module.bestSide(lm, module.EXERCISE_CONFIG.curl.required)).toBe(0);
    module.VisionCoach.processExercise(lm);
    expect(nodes.get("vision-angle")?.textContent).toBe("90 deg");
  });

  it("maps catalogue names to the right analysis rules", () => {
    const key = module.coachKeyFor;
    expect(key("Barbell Back Squat")).toBe("squat");
    expect(key("Dumbbell Biceps Curl")).toBe("curl");
    expect(key("Push-Up")).toBe("pushup");
    expect(key("Bent Over Row")).toBe("row");
    expect(key("Seated Cable Row")).toBe("seatedrow");
    expect(key("Lying Leg Curl")).toBe("legCurl");
    expect(key("Burpee")).toBeNull();
  });

  it("gives seated-row torso feedback without bent-over hinge rules", () => {
    const row = module.EXERCISE_CONFIG.seatedrow;
    const leaning = pose({ ...both(SHOULDERS, 0.7, 0.3), ...both(HIPS, 0.5, 0.7) });
    const upright = pose({ ...both(SHOULDERS, 0.5, 0.3), ...both(HIPS, 0.5, 0.7) });
    expect(row.feedback(80, "down", leaning)).toBe("Keep your torso more stable");
    expect(row.feedback(130, "down", upright)).toBe("Complete a comfortable range of motion");
  });

  it("keeps the loop alive when a frame throws", () => {
    const coach = module.VisionCoach;
    coach.running = true;
    coach.tick = () => { throw new Error("boom"); };
    coach.loop();
    expect(coach.running).toBe(true);
    expect(rafCalls.count).toBe(1); // next frame still scheduled
  });

  it("reports a lost pose instead of leaving stale feedback, after a short grace period", () => {
    const coach = module.VisionCoach;
    coach.handleNoPose(1000);
    expect(nodes.get("camera-feedback")?.textContent ?? "").toBe("");
    coach.handleNoPose(1700);
    expect(nodes.get("camera-feedback")?.textContent).toContain("can't see you");
  });

  it("never shows the server's generic 'model not configured' text as coaching", async () => {
    const built = makeDocument();
    const api = { post: async () => ({
      modelConfigured: false,
      confidence: 0.35,
      feedback: [{ cue: "Keep the movement controlled and capture a full repetition from a clear angle." }],
    }) };
    const m = loadModule(built.documentStub, api);
    m.VisionCoach.running = true;
    m.VisionCoach.video = { videoWidth: 0, videoHeight: 0, readyState: 0 };
    m.VisionCoach.coachFrameBuffer = Array.from({ length: 8 }, () => []);
    m.VisionCoach.currentExercise = "burpee";
    await m.VisionCoach.requestUniversalCoachAnalysis();
    expect(m.VisionCoach.coachFeedback).toBe("");
    expect(m.VisionCoach.aiCoachAvailable).toBe(false);
    m.VisionCoach.processExercise(pose({}));
    expect(built.nodes.get("camera-feedback")?.textContent).toContain("No form rules exist for this exercise yet");
  });

  it("drops stale AI feedback after its time-to-live", () => {
    const coach = module.VisionCoach;
    coach.currentExercise = "burpee";
    coach.aiCoachAvailable = true;
    coach.coachFeedback = "Brace your core.";
    coach.coachFeedbackAt = 0;
    clock.t = 1000;
    coach.processExercise(pose({}));
    expect(nodes.get("camera-feedback")?.textContent).toBe("Brace your core.");
    clock.t = 20000;
    coach.processExercise(pose({}));
    expect(nodes.get("camera-feedback")?.textContent).not.toBe("Brace your core.");
  });
});
