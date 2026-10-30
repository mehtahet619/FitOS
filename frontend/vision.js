import { PoseLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

/* ----------------------------------------------------------------------
 * Deterministic rep-counting logic (no AI call involved — the pose model
 * only extracts joint coordinates; angle math and rep state machines below
 * are plain trigonometry, same spirit as the rest of the app's engines).
 * -------------------------------------------------------------------- */

const LANDMARK = {
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
  LEFT_WRIST: 15, RIGHT_WRIST: 16,
  LEFT_HIP: 23, RIGHT_HIP: 24,
  LEFT_KNEE: 25, RIGHT_KNEE: 26,
  LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
};

// MediaPipe returns x/y normalised by image width/height separately, so on a
// non-square frame equal normalised distances are NOT equal pixel distances.
// Every 2D angle/length below scales x by width/height so geometry is
// measured in the same units on both axes (updated from the video each frame).
let frameAspect = 1;
function setFrameAspect(width, height) {
  frameAspect = width > 0 && height > 0 ? width / height : 1;
}

function angleBetween(a, b, c) {
  // angle at point b, formed by rays b->a and b->c, in degrees
  const ab = { x: (a.x - b.x) * frameAspect, y: a.y - b.y };
  const cb = { x: (c.x - b.x) * frameAspect, y: c.y - b.y };
  const dot = ab.x * cb.x + ab.y * cb.y;
  const magAB = Math.hypot(ab.x, ab.y);
  const magCB = Math.hypot(cb.x, cb.y);
  if (magAB === 0 || magCB === 0) return 0;
  const cos = Math.min(1, Math.max(-1, dot / (magAB * magCB)));
  return (Math.acos(cos) * 180) / Math.PI;
}

// The body side (0 = left, 1 = right) used for the current frame. Joints of ONE
// angle must all come from the same side; choosing the more visible side per
// joint independently mixed e.g. left hip + right knee + left ankle and made
// the angle jump between frames.
let activeSide = null;

function bestSide(lm, groups) {
  const score = (offset) => groups.reduce((sum, [left, right]) => {
    const point = lm[offset === 0 ? left : right];
    return sum + (point ? (point.visibility ?? 1) : 0);
  }, 0);
  const left = score(0);
  const right = score(1);
  // Hysteresis: keep the current side unless the other is clearly better.
  if (activeSide === 0 && left + 0.3 >= right) return 0;
  if (activeSide === 1 && right + 0.3 >= left) return 1;
  return left >= right ? 0 : 1;
}

function pick(landmarks, leftIdx, rightIdx) {
  const l = landmarks[leftIdx];
  const r = landmarks[rightIdx];
  if (activeSide === 0 && l) return l;
  if (activeSide === 1 && r) return r;
  if (!l) return r;
  if (!r) return l;
  return (l.visibility ?? 1) >= (r.visibility ?? 1) ? l : r;
}

/* ----------------------------------------------------------------------
 * Form comparison (optional).
 *
 * Rep counting above is unchanged. When the backend reports that the
 * comparison service is configured and reachable, each completed repetition
 * is submitted there for reference-based feedback. Every failure path falls
 * back to the existing Vision Coach behaviour: the results panel hides and
 * a short message is shown instead.
 * -------------------------------------------------------------------- */

// One MediaPipe landmark vector is (x, y, z, visibility) for each of 33 points.
const LANDMARK_VECTOR_LENGTH = 33 * 4;
const MAX_CAPTURED_FRAMES = 180;
const MAX_SUBMITTED_FRAMES = 60;
// Pose runs at ~30-60fps; every other frame is enough to describe one rep.
const FRAME_SAMPLE_STRIDE = 2;

const COMPARISON_UNAVAILABLE_MESSAGE =
  "Exercise form analysis is temporarily unavailable. We're working to restore it. You can continue using the other FitOS features.";
const COMPARISON_NO_RESULT_MESSAGE = "We couldn't analyze this movement right now. Please try again in a moment.";

function round4(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 10000) / 10000 : 0;
}

function flattenLandmarks(landmarks) {
  const vector = [];
  for (const point of landmarks) {
    vector.push(round4(point.x), round4(point.y), round4(point.z), round4(point.visibility ?? 1));
  }
  return vector;
}

/**
 * Evenly resamples a rep to `targetCount` frames. The reference and the user
 * sequence are always resampled to the same length so the comparison service
 * receives two sequences of one identical shape.
 */
function resampleFrames(frames, targetCount) {
  if (targetCount < 2 || frames.length <= targetCount) return frames;
  const out = [];
  for (let i = 0; i < targetCount; i += 1) {
    out.push(frames[Math.round((i * (frames.length - 1)) / (targetCount - 1))]);
  }
  return out;
}

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}


/* ----------------------------------------------------------------------
 * Live form coaching.
 *
 * Every rule below is computed only from the current frame's MediaPipe
 * landmarks (normalised image coordinates) and is evaluated on each frame in
 * the pose loop, so the on-screen cue reacts while the user is still moving
 * instead of only after a repetition has finished.
 *
 * IMPORTANT: the project holds no pose/reference data for the exercise
 * demonstration videos — a YouTube video id or URL does not contain extracted
 * landmarks. These cues therefore come strictly from geometry that is genuinely
 * measurable from the landmarks (joint angles, torso orientation, elbow
 * position relative to the torso, body-line alignment). No comparison against
 * the demonstration is performed or implied.
 * -------------------------------------------------------------------- */

// Below this the pose model is not confident enough about a joint to coach on it.
const MIN_LANDMARK_VISIBILITY = 0.35;

/** True when at least one of the left/right landmarks of every joint group is usable. */
function hasVisiblePose(lm, groups) {
  return groups.every(([left, right]) =>
    [left, right].some((index) => {
      const point = lm[index];
      return Boolean(point) && (point.visibility ?? 1) >= MIN_LANDMARK_VISIBILITY;
    }));
}

/** True when any landmark group needed for this exercise has a usable side. */
function hasAnyVisiblePoseLandmark(lm, groups) {
  return groups.some(([left, right]) =>
    [left, right].some((index) => {
      const point = lm[index];
      return Boolean(point) && (point.visibility ?? 1) >= MIN_LANDMARK_VISIBILITY;
    }));
}

/** Degrees a segment (top -> bottom) is tilted away from vertical; 0 = straight up/down. */
function tiltFromVertical(top, bottom) {
  const dx = (bottom.x - top.x) * frameAspect;
  const dy = bottom.y - top.y;
  return (Math.atan2(Math.abs(dx), Math.abs(dy)) * 180) / Math.PI;
}

/**
 * Perpendicular distance between a point and the torso line (shoulder -> hip),
 * as a fraction of torso length. 0 means the point sits exactly on the torso
 * line; larger values mean the point has drifted away from the body.
 */
function torsoLineOffset(point, shoulder, hip) {
  const dx = (hip.x - shoulder.x) * frameAspect;
  const dy = hip.y - shoulder.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return 0;
  const px = (point.x - shoulder.x) * frameAspect;
  const py = point.y - shoulder.y;
  return Math.abs(px * dy - py * dx) / (length * length);
}

/**
 * Signed vertical position of the hip relative to the shoulder -> ankle line,
 * as a fraction of shoulder-to-ankle distance. Positive = hips below the line
 * (sagging); negative = hips above the line (piking).
 */
function hipLineDeviation(shoulder, hip, ankle) {
  const dx = (ankle.x - shoulder.x) * frameAspect;
  const dy = ankle.y - shoulder.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return 0;
  const t = ankle.x === shoulder.x ? 0 : (hip.x - shoulder.x) / (ankle.x - shoulder.x);
  const lineY = shoulder.y + dy * t;
  return (hip.y - lineY) / length;
}

function coachKeyFor(name = "", movementPattern = "") {
  return classifyExercise(name, movementPattern).key;
}

const EXERCISE_CONFIG = {
  squat: {
    label: "Squat",
    required: [
      [LANDMARK.LEFT_HIP, LANDMARK.RIGHT_HIP],
      [LANDMARK.LEFT_KNEE, LANDMARK.RIGHT_KNEE],
      [LANDMARK.LEFT_ANKLE, LANDMARK.RIGHT_ANKLE],
    ],
    angleOf(lm) {
      const hip = pick(lm, LANDMARK.LEFT_HIP, LANDMARK.RIGHT_HIP);
      const knee = pick(lm, LANDMARK.LEFT_KNEE, LANDMARK.RIGHT_KNEE);
      const ankle = pick(lm, LANDMARK.LEFT_ANKLE, LANDMARK.RIGHT_ANKLE);
      return angleBetween(hip, knee, ankle);
    },
    upThreshold: 160,   // standing
    downThreshold: 100, // bottom of squat
    feedback(angle, phase) {
      if (phase === "down" && angle > 110) return "Go a little lower — full range of motion";
      if (phase === "down") return "Good depth";
      return "Stand tall, then squat down";
    },
  },
  curl: {
    label: "Curl",
    required: [
      [LANDMARK.LEFT_SHOULDER, LANDMARK.RIGHT_SHOULDER],
      [LANDMARK.LEFT_ELBOW, LANDMARK.RIGHT_ELBOW],
      [LANDMARK.LEFT_WRIST, LANDMARK.RIGHT_WRIST],
      [LANDMARK.LEFT_HIP, LANDMARK.RIGHT_HIP],
    ],
    angleOf(lm) {
      const shoulder = pick(lm, LANDMARK.LEFT_SHOULDER, LANDMARK.RIGHT_SHOULDER);
      const elbow = pick(lm, LANDMARK.LEFT_ELBOW, LANDMARK.RIGHT_ELBOW);
      const wrist = pick(lm, LANDMARK.LEFT_WRIST, LANDMARK.RIGHT_WRIST);
      return angleBetween(shoulder, elbow, wrist);
    },
    upThreshold: 150, // arm extended
    downThreshold: 50, // fully curled
    feedback(angle, phase, lm) {
      const shoulder = pick(lm, LANDMARK.LEFT_SHOULDER, LANDMARK.RIGHT_SHOULDER);
      const hip = pick(lm, LANDMARK.LEFT_HIP, LANDMARK.RIGHT_HIP);
      const elbow = pick(lm, LANDMARK.LEFT_ELBOW, LANDMARK.RIGHT_ELBOW);

      // The torso should stay close to vertical; tipping it means the weight is
      // being swung up with the body rather than curled with the arm.
      if (tiltFromVertical(shoulder, hip) > 25) return "Avoid swinging your upper body";

      // The elbow should track close to the torso line; drifting out to the
      // side is the classic "chicken wing" fault.
      if (torsoLineOffset(elbow, shoulder, hip) > 0.3) return "Keep your elbows close to your torso";

      if (phase === "down" && angle > 60) return "Curl a bit higher — full range of motion";
      if (phase === "down") return "Nice squeeze";
      return "Extend fully between reps";
    },
  },
  row: {
    label: "Bent Over Row",
    required: [
      [LANDMARK.LEFT_SHOULDER, LANDMARK.RIGHT_SHOULDER],
      [LANDMARK.LEFT_ELBOW, LANDMARK.RIGHT_ELBOW],
      [LANDMARK.LEFT_WRIST, LANDMARK.RIGHT_WRIST],
      [LANDMARK.LEFT_HIP, LANDMARK.RIGHT_HIP],
      [LANDMARK.LEFT_KNEE, LANDMARK.RIGHT_KNEE],
    ],
    angleOf(lm) {
      const shoulder = pick(lm, LANDMARK.LEFT_SHOULDER, LANDMARK.RIGHT_SHOULDER);
      const elbow = pick(lm, LANDMARK.LEFT_ELBOW, LANDMARK.RIGHT_ELBOW);
      const wrist = pick(lm, LANDMARK.LEFT_WRIST, LANDMARK.RIGHT_WRIST);
      return angleBetween(shoulder, elbow, wrist);
    },
    upThreshold: 150,
    downThreshold: 75,
    feedback(angle, phase, lm) {
      const shoulder = pick(lm, LANDMARK.LEFT_SHOULDER, LANDMARK.RIGHT_SHOULDER);
      const hip = pick(lm, LANDMARK.LEFT_HIP, LANDMARK.RIGHT_HIP);
      const knee = pick(lm, LANDMARK.LEFT_KNEE, LANDMARK.RIGHT_KNEE);
      const torsoAngle = angleBetween(shoulder, hip, knee);
      // Hip angle (shoulder-hip-knee): ~180 upright, ~100-140 when hinged correctly.
      if (torsoAngle > 160) return "Hinge forward from your hips and keep your back neutral";
      if (torsoAngle < 60) return "Keep your chest up — avoid folding too far forward";
      if (phase === "down" && angle > 90) return "Pull your elbows back and bring the weight toward your lower ribs";
      if (phase === "down") return "Squeeze your shoulder blades without jerking your torso";
      return "Lower your arms with control, keeping your torso still";
    },
  },
  seatedrow: {
    label: "Seated Cable Row",
    required: [
      [LANDMARK.LEFT_SHOULDER, LANDMARK.RIGHT_SHOULDER],
      [LANDMARK.LEFT_ELBOW, LANDMARK.RIGHT_ELBOW],
      [LANDMARK.LEFT_WRIST, LANDMARK.RIGHT_WRIST],
      [LANDMARK.LEFT_HIP, LANDMARK.RIGHT_HIP],
    ],
    angleOf(lm) {
      const shoulder = pick(lm, LANDMARK.LEFT_SHOULDER, LANDMARK.RIGHT_SHOULDER);
      const elbow = pick(lm, LANDMARK.LEFT_ELBOW, LANDMARK.RIGHT_ELBOW);
      const wrist = pick(lm, LANDMARK.LEFT_WRIST, LANDMARK.RIGHT_WRIST);
      return angleBetween(shoulder, elbow, wrist);
    },
    upThreshold: 150,  // arms extended at the start / end of the return
    downThreshold: 95, // handle pulled to the torso
    feedback(angle, phase, lm) {
      const shoulder = pick(lm, LANDMARK.LEFT_SHOULDER, LANDMARK.RIGHT_SHOULDER);
      const hip = pick(lm, LANDMARK.LEFT_HIP, LANDMARK.RIGHT_HIP);
      // Seated, the torso should stay near vertical; leaning back to finish the
      // pull is the common fault. Needs a side-on camera view.
      if (tiltFromVertical(shoulder, hip) > 25) return "Keep your torso more stable";
      if (phase === "down" && angle > 110) return "Complete a comfortable range of motion";
      if (phase === "down") return "Good pull — squeeze, then control the return";
      return "Reach forward to full extension before the next rep";
    },
  },
  pushup: {
    label: "Push-up",
    required: [
      [LANDMARK.LEFT_SHOULDER, LANDMARK.RIGHT_SHOULDER],
      [LANDMARK.LEFT_ELBOW, LANDMARK.RIGHT_ELBOW],
      [LANDMARK.LEFT_WRIST, LANDMARK.RIGHT_WRIST],
      [LANDMARK.LEFT_HIP, LANDMARK.RIGHT_HIP],
      [LANDMARK.LEFT_ANKLE, LANDMARK.RIGHT_ANKLE],
    ],
    angleOf(lm) {
      const shoulder = pick(lm, LANDMARK.LEFT_SHOULDER, LANDMARK.RIGHT_SHOULDER);
      const elbow = pick(lm, LANDMARK.LEFT_ELBOW, LANDMARK.RIGHT_ELBOW);
      const wrist = pick(lm, LANDMARK.LEFT_WRIST, LANDMARK.RIGHT_WRIST);
      return angleBetween(shoulder, elbow, wrist);
    },
    upThreshold: 150,
    downThreshold: 90,
    feedback(angle, phase, lm) {
      const shoulder = pick(lm, LANDMARK.LEFT_SHOULDER, LANDMARK.RIGHT_SHOULDER);
      const hip = pick(lm, LANDMARK.LEFT_HIP, LANDMARK.RIGHT_HIP);
      const ankle = pick(lm, LANDMARK.LEFT_ANKLE, LANDMARK.RIGHT_ANKLE);

      // Hips should stay in line with shoulders and ankles; the sign of the
      // deviation separates sagging from piking.
      const deviation = hipLineDeviation(shoulder, hip, ankle);
      if (deviation > 0.08) return "Keep your hips up — avoid sagging";
      if (deviation < -0.08) return "Lower your hips — avoid piking";

      if (phase === "down" && angle > 100) return "Lower your chest more — full range of motion";
      if (phase === "down") return "Good depth";
      return "Lock out at the top";
    },
  },
};


const ROLE = {
  shoulder: [LANDMARK.LEFT_SHOULDER, LANDMARK.RIGHT_SHOULDER],
  elbow: [LANDMARK.LEFT_ELBOW, LANDMARK.RIGHT_ELBOW],
  wrist: [LANDMARK.LEFT_WRIST, LANDMARK.RIGHT_WRIST],
  hip: [LANDMARK.LEFT_HIP, LANDMARK.RIGHT_HIP],
  knee: [LANDMARK.LEFT_KNEE, LANDMARK.RIGHT_KNEE],
  ankle: [LANDMARK.LEFT_ANKLE, LANDMARK.RIGHT_ANKLE],
};

const CHECKS = {
  torsoLean(lm, p) {
    const shoulder = pick(lm, ...ROLE.shoulder);
    const hip = pick(lm, ...ROLE.hip);
    return tiltFromVertical(shoulder, hip) > p.max ? p.msg : null;
  },
  elbowTuck(lm, p) {
    const shoulder = pick(lm, ...ROLE.shoulder);
    const hip = pick(lm, ...ROLE.hip);
    const elbow = pick(lm, ...ROLE.elbow);
    return torsoLineOffset(elbow, shoulder, hip) > p.max ? p.msg : null;
  },
  hipLine(lm) {
    const deviation = hipLineDeviation(pick(lm, ...ROLE.shoulder), pick(lm, ...ROLE.hip), pick(lm, ...ROLE.ankle));
    if (deviation > 0.08) return "Keep your hips up — avoid sagging";
    if (deviation < -0.08) return "Lower your hips — avoid piking";
    return null;
  },
};

// angle: three roles, angle measured at the middle one. up/down: high/low angle
// thresholds. startsLow: the resting position is the LOW angle (e.g. overhead
// press starts with bent elbows and the working phase is the extended one).
const PATTERNS = {
  pressHorizontal: {
    label: "Horizontal press / dip", angle: ["shoulder", "elbow", "wrist"], up: 150, down: 90, view: "side",
    restMsg: "Press to full lockout, then lower with control", workMsg: "Good depth — drive back up",
  },
  pressVertical: {
    label: "Overhead press", angle: ["shoulder", "elbow", "wrist"], needs: ["hip"], up: 155, down: 100, startsLow: true, view: "front",
    checks: [{ type: "torsoLean", max: 20, msg: "Keep your ribs down — avoid leaning back" }],
    restMsg: "Press up until your arms are straight", workMsg: "Lockout overhead, then lower with control",
  },
  pullVertical: {
    label: "Pull-up / pulldown", angle: ["shoulder", "elbow", "wrist"], needs: ["hip"], up: 150, down: 85, view: "front",
    checks: [{ type: "torsoLean", max: 25, msg: "Avoid swinging — keep your torso steady" }],
    restMsg: "Start from a full hang, then pull", workMsg: "Good pull — lower with control",
  },
  tricepsExtension: {
    label: "Triceps extension", angle: ["shoulder", "elbow", "wrist"], up: 155, down: 100, startsLow: true, view: "side",
    restMsg: "Extend your arms fully", workMsg: "Squeeze at the top, then return slowly",
  },
  tricepsPushdown: {
    label: "Triceps pushdown", angle: ["shoulder", "elbow", "wrist"], needs: ["hip"], up: 155, down: 100, startsLow: true, view: "side",
    checks: [
      { type: "elbowTuck", max: 0.3, msg: "Keep your elbows pinned to your sides" },
      { type: "torsoLean", max: 25, msg: "Stay tall — avoid leaning over the weight" },
    ],
    restMsg: "Push down until your arms are straight", workMsg: "Squeeze at the bottom, then return slowly",
  },
  lunge: {
    label: "Lunge / step-up", angle: ["hip", "knee", "ankle"], up: 160, down: 110, view: "side",
    restMsg: "Stand tall, then lower with control", workMsg: "Good depth — drive up through the front foot",
  },
  legPress: {
    label: "Leg press", angle: ["hip", "knee", "ankle"], up: 155, down: 100, view: "side",
    restMsg: "Press to near-full extension", workMsg: "Good depth — press back up",
  },
  hinge: {
    label: "Hip hinge", angle: ["shoulder", "hip", "knee"], up: 160, down: 125, view: "side",
    restMsg: "Stand tall, then hinge at the hips", workMsg: "Good hinge — drive your hips forward to stand",
  },
  hipThrust: {
    label: "Hip thrust / bridge", angle: ["shoulder", "hip", "knee"], up: 155, down: 125, startsLow: true, view: "side",
    restMsg: "Drive your hips up", workMsg: "Squeeze at the top, then lower with control",
  },
  lateralRaise: {
    label: "Lateral raise", angle: ["hip", "shoulder", "elbow"], up: 70, down: 35, startsLow: true, view: "front",
    checks: [{ type: "torsoLean", max: 15, msg: "Avoid swinging your torso" }],
    restMsg: "Raise your arms out to the sides", workMsg: "Good height — lower with control",
  },
  frontRaise: {
    label: "Front raise", angle: ["hip", "shoulder", "elbow"], up: 70, down: 35, startsLow: true, view: "side",
    checks: [{ type: "torsoLean", max: 15, msg: "Avoid leaning back to lift the weight" }],
    restMsg: "Raise your arms in front of you", workMsg: "Good height — lower with control",
  },
  legCurl: {
    label: "Leg curl", angle: ["hip", "knee", "ankle"], up: 150, down: 100, view: "side",
    restMsg: "Extend your legs, then curl", workMsg: "Squeeze, then lower with control",
  },
  legExtension: {
    label: "Leg extension", angle: ["hip", "knee", "ankle"], up: 150, down: 110, startsLow: true, view: "side",
    restMsg: "Extend your legs fully", workMsg: "Squeeze at the top, then lower slowly",
  },
  legRaise: {
    label: "Leg raise", angle: ["shoulder", "hip", "knee"], up: 150, down: 115, view: "side",
    restMsg: "Lower your legs with control", workMsg: "Good lift — lower slowly",
  },
};

function buildPatternConfig(def) {
  const roles = [...new Set([...def.angle, ...(def.needs || [])])];
  const triplet = def.angle.map((role) => ROLE[role]);
  return {
    label: def.label,
    pattern: true,
    experimental: true,
    view: def.view,
    required: roles.map((role) => ROLE[role]),
    startsLow: Boolean(def.startsLow),
    upThreshold: def.up,
    downThreshold: def.down,
    angleOf(lm) {
      const [a, b, c] = triplet.map(([left, right]) => pick(lm, left, right));
      return angleBetween(a, b, c);
    },
    feedback(angle, phase, lm) {
      for (const check of def.checks || []) {
        const message = CHECKS[check.type](lm, check);
        if (message) return message;
      }
      return phase === "down" ? def.workMsg : def.restMsg;
    },
  };
}

for (const [key, def] of Object.entries(PATTERNS)) EXERCISE_CONFIG[key] = buildPatternConfig(def);
// Preserve the dedicated seated-row config: its upright-torso cue differs from bent-over rows.

// Static hold: form cues only, no repetitions.
EXERCISE_CONFIG.plank = {
  label: "Plank",
  hold: true,
  experimental: true,
  view: "side",
  required: [ROLE.shoulder, ROLE.hip, ROLE.ankle],
  angleOf: () => 0,
  upThreshold: 0,
  downThreshold: 0,
  feedback: (angle, phase, lm) => CHECKS.hipLine(lm) || "Hold — keep a straight line from shoulders to ankles",
};

const TRACKING_REASONS = {
  cardio: "Cardio and conditioning movements are not rep-counted.",
  complex: "Complex, rotational or carrying movements can't be rep-counted reliably from one 2D camera.",
  isolation: "This isolation movement can't be measured reliably from a single 2D camera, so reps and form aren't scored.",
  hold: "Static holds other than plank aren't scored yet.",
};

/**
 * Classifies a catalogue exercise name. Order matters: specific movements are
 * tested before generic words ("leg curl" before "curl", "leg press" before
 * "press"). Returns { key, kind, reason }.
 */
function classifyExercise(name = "", movementPattern = "") {
  const n = String(name).toLowerCase().replace(/[^a-z0-9.\s-]/g, " ").replace(/\s+/g, " ").trim();
  const has = (re) => re.test(n);
  const counted = (key) => ({ key, kind: EXERCISE_CONFIG[key].hold ? "hold" : "counted", reason: "" });
  const tracking = (reason) => ({ key: null, kind: "tracking", reason: TRACKING_REASONS[reason] });
  if (!n) return { key: null, kind: "unknown", reason: "" };

  if (has(/\bplank\b/)) return counted("plank");
  if (has(/hollow|wall.?sit|dead.?hang|isometric|\bhold\b/)) return tracking("hold");
  if (has(/treadmill|cycling|\bbike\b|battle.?rope|jump|burpee|mountain.?climber|\brun(ning)?\b|elliptical|stair|\bsled\b/)) return tracking("cardio");
  if (has(/\bclean\b|snatch|\bjerk\b|swing|thruster|wood.?chop|\bchop\b|twist|rotation|rotary|windmill|turkish|get.?up|carry|\bwalk\b|pallof|\bpull\b.*\bsled\b/)) return tracking("complex");

  if (has(/nordic/)) return tracking("isolation"); // knees fixed, torso lowers: not a knee-angle movement
  if (has(/leg.?curl|hamstring.?curl/)) return counted("legCurl");
  if (has(/leg.?extension|knee.?extension/)) return counted("legExtension");
  if (has(/back.?extension|hyper.?extension|wrist.?curl|forearm/)) return tracking("isolation");
  if (has(/leg.?raise|knee.?raise|hanging.?raise/)) return counted("legRaise");
  if (has(/calf|shrug|crunch|sit.?up|\babs?\b|v.?up|russian|bicycle|glute.?kickback|donkey|hip.?abduct|hip.?adduct/)) return tracking("isolation");
  if (has(/superman/)) return tracking("isolation"); // prone back extension, not a row
  if (has(/upright.?row|face.?pull|pull.?apart|\bflyes?\b|\bfly\b|pec.?deck|cross.?over|rear.?delt|reverse.?fly/)) return tracking("isolation");
  if (has(/kickback/)) return has(/tricep/) ? counted("tricepsExtension") : tracking("isolation");

  if (has(/lateral.?raise|side.?raise/)) return counted("lateralRaise");
  if (has(/front.?raise|plate.?raise/)) return counted("frontRaise");
  if (has(/\braise\b/)) return tracking("isolation");

  if (has(/leg.?press|hack.?press/)) return counted("legPress");
  if (has(/\bsquat\b|goblet|sissy|pistol|hack/)) return counted("squat");
  if (has(/lunge|step.?up|split.?squat/)) return counted("lunge");
  if (has(/hip.?thrust|glute.?bridge|\bbridge\b|hip.?raise/)) return counted("hipThrust");
  if (has(/deadlift|\brdl\b|romanian|good.?morning|pull.?through|stiff.?leg|hip.?hinge/)) return counted("hinge");

  // Pike push-ups keep the hips high on purpose, so they must not use the push-up hip-line check.
  if (has(/pike/)) return counted("pressHorizontal");
  if (has(/push.?up|press.?up/)) return counted("pushup");
  if (has(/\bdips?\b/)) return counted("pressHorizontal");
  // Triceps work is tested before "overhead" so "Overhead Triceps Extension" is not an overhead press.
  if (has(/push.?down|pushdown|press.?down|skull|tricep|overhead.?extension/)) {
    return counted(has(/push.?down|pushdown|press.?down/) ? "tricepsPushdown" : "tricepsExtension");
  }
  if (has(/overhead|shoulder.?press|military|arnold|push.?press|landmine|kettlebell.?press/)) return counted("pressVertical");
  if (has(/bench|chest.?press|(floor|incline|decline|flat).{0,20}press/)) return counted("pressHorizontal");
  if (has(/pull.?down|pulldown|pull.?up|chin.?up|lat.?pull/)) return counted("pullVertical");
  if (has(/seated.?(cable.?)?row|cable.?row|machine.?row|low.?row/)) return counted("seatedrow");
  if (has(/\brow(ing)?\b/)) return counted("row");
  if (has(/curl/)) return counted("curl");

  // Name not recognised: fall back to the catalogue's own movementPattern field
  // (sent with every workout exercise), so exercises added to the catalogue later
  // still get coaching without any code change.
  const hinted = MOVEMENT_PATTERN_HINTS[String(movementPattern || "").toLowerCase()];
  if (hinted) return typeof hinted === "string" && EXERCISE_CONFIG[hinted] ? counted(hinted) : tracking(hinted.tracking);
  return { key: null, kind: "unknown", reason: "" };
}

const MOVEMENT_PATTERN_HINTS = {
  horizontal_push: "pressHorizontal",
  vertical_push: "pressVertical",
  horizontal_pull: "row",
  vertical_pull: "pullVertical",
  squat: "squat",
  lunge: "lunge",
  hinge: "hinge",
  elbow_flexion: "curl",
  elbow_extension: "tricepsExtension",
  flexion: { tracking: "isolation" },
  plantarflexion: { tracking: "isolation" },
  abduction: { tracking: "isolation" },
  anti_extension: { tracking: "isolation" },
  rotation: { tracking: "complex" },
  flexion_rotation: { tracking: "complex" },
  dynamic: { tracking: "cardio" },
};
// A phase change must hold for this many consecutive frames, and the angle is
// lightly smoothed, so single noisy frames cannot flip phases or add reps.
const PHASE_CONFIRM_FRAMES = 2;
const ANGLE_SMOOTHING = 0.5; // weight of the newest sample
// A new coaching cue must persist this many frames and the previous cue must
// have been on screen this long (ms) before the text changes.
const CUE_CONFIRM_FRAMES = 3;
const CUE_MIN_HOLD_MS = 1200;
// Pose lost for this long (ms) => say so instead of showing stale feedback.
const NO_POSE_GRACE_MS = 600;
// AI feedback older than this (ms) is stale and is no longer displayed.
const AI_FEEDBACK_TTL_MS = 8000;
const MAX_CONSECUTIVE_LOOP_ERRORS = 30;
const FRAMING_MESSAGE_UNSUPPORTED =
  "No form rules exist for this exercise yet and AI coaching is not enabled, so only pose tracking is active.";

function cameraErrorMessage(error) {
  const name = error?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Camera permission was denied. Allow camera access in your browser settings and try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No usable camera was found on this device.";
  if (name === "NotReadableError" || name === "AbortError") return "The camera is in use by another app or could not be started.";
  return `Couldn't start the camera or load the pose model (needs internet + camera permission). ${error?.message || ""}`.trim();
}

const VisionCoach = {
  starting: false,
  startToken: 0,
  smoothedAngle: null,
  phaseFrames: 0,
  noPoseSince: 0,
  loopErrors: 0,
  poseDelegate: null,
  aiCoachAvailable: null, // null = not probed yet, false = backend has no model
  coachFeedbackAt: 0,
  cue: { candidate: "", count: 0, shown: "", shownAt: 0 },
  landmarker: null,
  running: false,
  currentExercise: "squat",
  repCount: 0,
  phase: "up", // "up" | "down"
  video: null,
  canvas: null,
  ctx: null,
  equipmentCanvas: null,
  crowdCanvas: null,
  crowdTimer: null,
  crowdRequestInFlight: false,
  crowdIntervalMs: 2500,
  equipmentTimer: null,
  equipmentRequestInFlight: false,
  equipmentHistory: [],
  stableEquipment: [],
  lastEquipmentRequestAt: 0,
  equipmentIntervalMs: 1500,
  equipmentMinConfidence: 0.35,
  coachExerciseName: "Squat",
  coachFrameBuffer: [],
  coachLastSampleAt: 0,
  coachLastRequestAt: 0,
  coachLastIdentifyAt: 0,
  coachRequestInFlight: false,
  coachIdentifyInFlight: false,
  coachFeedback: "",

  // Form comparison state. `baselineFrames` holds the first completed rep of the
  // session; later reps are compared against it so both sequences come from the
  // same person, camera and framing.
  comparison: {
    configured: null,
    available: null,
    inFlight: false,
    capturing: false,
    frameCounter: 0,
    currentFrames: [],
    baselineFrames: null,
    unsupported: false,
  },

  async init() {
    this.video = document.getElementById("vision-video");
    this.canvas = document.getElementById("vision-canvas");
    this.ctx = this.canvas.getContext("2d");
    this.equipmentCanvas = document.createElement("canvas");
    this.crowdCanvas = document.createElement("canvas");

    document.querySelectorAll("#vision-segment button").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#vision-segment button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this.currentExercise = btn.dataset.exercise;
        this.coachExerciseName = EXERCISE_CONFIG[this.currentExercise]?.label || this.currentExercise;
        this.coachFeedback = "";
        this.coachFrameBuffer = [];
        this.resetReps();
      });
    });

    document.getElementById("vision-start-btn").addEventListener("click", () => {
      if (this.running) this.stop();
      else void this.start();
    });
    document.getElementById("vision-reset-btn").addEventListener("click", () => this.resetReps());
    document.getElementById("form-comparison-retry-btn").addEventListener("click", () => this.retryComparison());

    // Release the camera when the user leaves the Vision screen, and drop
    // smoothing state after the tab was backgrounded (frames were not processed).
    const screen = document.getElementById("screen-vision");
    if (screen && typeof MutationObserver !== "undefined") {
      new MutationObserver(() => {
        if (!screen.classList.contains("active") && (this.running || this.starting)) this.stop();
      }).observe(screen, { attributes: true, attributeFilter: ["class"] });
    }
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) { this.smoothedAngle = null; this.phaseFrames = 0; }
    });
  },

  async openFor(exercise) {
    const exerciseName = String(exercise?.exerciseName || exercise?.name || "Unknown exercise");
    const classification = classifyExercise(exerciseName, exercise?.movementPattern || exercise?.movement_pattern || "");
    const key = classification.key;
    this.trackingReason = classification.reason || "";
    const placeholder = document.getElementById("camera-placeholder");
    const demoSection = document.getElementById("vision-demo");
    if (demoSection) demoSection.hidden = false;
    const demoLabel = document.getElementById("vision-demo-label");
    if (demoLabel) demoLabel.textContent = `Exercise Demonstration: ${exerciseName}`;

    // Every catalogue exercise can use the shared AI path. Only locally
    // validated movements use deterministic rep counting.
    this.currentExercise = key || "universal";
    this.coachExerciseName = exerciseName;
    this.coachFeedback = "";
    this.coachFrameBuffer = [];
    const startButton = document.getElementById("vision-start-btn");
    if (startButton) startButton.disabled = false;
    if (placeholder) placeholder.textContent = key
      ? 'Tap "Start Camera" to begin pose analysis in your browser.'
      : this.trackingReason
        ? `Pose tracking for ${exerciseName}: ${this.trackingReason} Rep counting is not enabled for this movement.`
        : `AI coaching for ${exerciseName}: keep your full body in frame. Sampled pose data and occasional camera frames may be sent to FitOS for AI analysis. Feedback depends on model confidence.`;
    document.querySelectorAll("#vision-segment button").forEach((button) => {
      button.classList.toggle("active", Boolean(key) && button.dataset.exercise === key);
    });
    this.resetReps();
    if (!this.running) await this.start();
  },

  resetReps() {
    this.repCount = 0;
    this.phase = EXERCISE_CONFIG[this.currentExercise]?.startsLow ? "down" : "up";
    this.smoothedAngle = null;
    this.phaseFrames = 0;
    this.cue = { candidate: "", count: 0, shown: "", shownAt: 0 };
    document.getElementById("vision-reps").textContent = "0";
    document.getElementById("vision-angle").textContent = "0 deg";
    this.resetComparisonCapture();
    const config = EXERCISE_CONFIG[this.currentExercise];
    const label = config?.label || this.coachExerciseName || "Exercise";
    const view = config?.view === "side" ? " Stand side-on to the camera." : config?.view === "front" ? " Face the camera." : "";
    const note = config?.experimental
      ? `${label}: rep counting and live cues for this movement are experimental estimates.${view}`
      : this.trackingReason
        ? `${label}: ${this.trackingReason} Pose tracking is active.`
        : `${label}: live pose analysis is active. Form cues are computed on your device from body landmarks.`;
    this.renderComparisonNotice(note);
  },

  resetComparisonCapture() {
    this.comparison.capturing = false;
    this.comparison.frameCounter = 0;
    this.comparison.currentFrames = [];
    this.comparison.baselineFrames = null;
    this.comparison.unsupported = false;
    this.renderComparisonResults(null);
  },

  async createLandmarker() {
    const withTimeout = (promise, timeoutMs, label) => {
      let timeoutId;
      const timeout = new Promise((_, reject) => {
        timeoutId = window.setTimeout(
          () => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds. Check your connection and retry.`)),
          timeoutMs,
        );
      });
      return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timeoutId));
    };

    // Bound network/model initialization so mobile browsers never leave the
    // Start Camera button spinning forever if a CDN request stalls.
    const vision = await withTimeout(
      FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
      ),
      15000,
      "Pose runtime download",
    );
    const modelAssetPath =
      "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
    // GPU is not available on every browser/device; fall back to CPU instead of
    // failing the whole feature. Give each delegate a bounded initialization time.
    for (const delegate of ["GPU", "CPU"]) {
      try {
        const landmarker = await withTimeout(
          PoseLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath, delegate },
            runningMode: "VIDEO",
            numPoses: 1,
          }),
          delegate === "GPU" ? 15000 : 20000,
          `${delegate} pose model initialization`,
        );
        this.poseDelegate = delegate;
        return landmarker;
      } catch (error) {
        console.warn(`[VisionCoach] ${delegate} pose model init failed`, error?.message || error);
        if (delegate === "CPU") throw error;
      }
    }
    return null;
  },

  async probeAiCoach() {
    try {
      const status = await Api.get("/coach/status");
      this.aiCoachAvailable = status?.multimodalCoach === "configured";
    } catch (_error) {
      this.aiCoachAvailable = false;
    }
  },

  async start() {
    if (this.starting || this.running) return;
    this.starting = true;
    const token = ++this.startToken;
    const placeholder = document.getElementById("camera-placeholder");
    const startBtn = document.getElementById("vision-start-btn");
    startBtn.disabled = true;
    startBtn.innerHTML = `<span class="spinner"></span> Loading model…`;

    try {
      if (!this.landmarker) this.landmarker = await this.createLandmarker();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      if (token !== this.startToken) {
        // stop() ran while the model/camera was loading: release the new stream.
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.getVideoTracks().forEach((track) => track.addEventListener("ended", () => {
        if (this.running && token === this.startToken) {
          this.stop();
          placeholder.textContent = "The camera was disconnected or taken by another app. Tap Start Camera to resume.";
        }
      }));
      this.video.srcObject = stream;
      this.video.style.display = "block";
      await this.video.play();
      placeholder.style.display = "none";
      document.getElementById("camera-feedback").style.display = "block";

      startBtn.textContent = "Stop Camera";
      startBtn.disabled = false;

      this.running = true;
      this.loopErrors = 0;
      this.noPoseSince = 0;
      this.smoothedAngle = null;
      this.phaseFrames = 0;
      this.startEquipmentRecognition();
      this.startCrowdAnalysis();
      void this.probeAiCoach();
      this.loop();
      this.showComparisonCard();
      this.setComparisonRetryVisible(false);
      this.renderComparisonNotice(EXERCISE_CONFIG[this.currentExercise]
        ? "Live pose analysis is active. Form cues are computed on your device from your body landmarks."
        : "Pose tracking is active. This exercise has no built-in form rules yet.");
    } catch (e) {
      placeholder.textContent = cameraErrorMessage(e);
      placeholder.style.display = "flex";
      startBtn.disabled = false;
      startBtn.textContent = "Start Camera";
      const stream = this.video.srcObject;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      this.video.srcObject = null;
      // Without pose detection there is nothing to compare, so the comparison
      // panel is cleared rather than left showing a stale result.
      this.resetComparisonCapture();
      this.hideComparisonCard();
    } finally {
      if (token === this.startToken) this.starting = false;
    }
  },

  stop() {
    this.startToken += 1; // cancels an in-flight start()
    this.starting = false;
    this.running = false;
    this.coachFrameBuffer = [];
    this.coachFeedback = "";
    this.coachFeedbackAt = 0;
    this.smoothedAngle = null;
    this.phaseFrames = 0;
    this.noPoseSince = 0;
    this.cue = { candidate: "", count: 0, shown: "", shownAt: 0 };
    if (this.crowdTimer) window.clearTimeout(this.crowdTimer);
    this.crowdTimer = null;
    this.crowdRequestInFlight = false;
    if (this.equipmentTimer) window.clearTimeout(this.equipmentTimer);
    this.equipmentTimer = null;
    this.equipmentRequestInFlight = false;
    this.equipmentHistory = [];
    this.stableEquipment = [];
    this.comparison.capturing = false;
    this.comparison.frameCounter = 0;
    this.comparison.currentFrames = [];
    const stream = this.video.srcObject;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
    this.video.style.display = "none";
    document.getElementById("camera-placeholder").style.display = "flex";
    document.getElementById("camera-placeholder").textContent = 'Tap "Start Camera" to begin pose analysis.';
    document.getElementById("camera-feedback").style.display = "none";
    const startBtn = document.getElementById("vision-start-btn");
    startBtn.disabled = false;
    startBtn.textContent = "Start Camera";
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.renderEquipmentState("Waiting for a frame…", []);
  },

  loop() {
    if (!this.running) return;
    // One bad frame must never end the loop: previously any exception here
    // skipped requestAnimationFrame and froze reps/angle at 0 while the camera
    // kept showing live video.
    try {
      this.tick();
      this.loopErrors = 0;
    } catch (error) {
      this.loopErrors += 1;
      console.warn("[VisionCoach] frame processing failed", error?.message || error);
      if (this.loopErrors >= MAX_CONSECUTIVE_LOOP_ERRORS) {
        this.stop();
        document.getElementById("camera-placeholder").textContent =
          "Pose tracking stopped after repeated errors. Tap Start Camera to try again.";
        return;
      }
    }
    requestAnimationFrame(() => this.loop());
  },

  tick() {
    if (document.hidden) return;
    const video = this.video;
    if (video.readyState < 2 || !video.videoWidth) return;
    const now = performance.now();
    const result = this.landmarker.detectForVideo(video, now);
    if (this.canvas.width !== video.videoWidth) this.canvas.width = video.videoWidth;
    if (this.canvas.height !== video.videoHeight) this.canvas.height = video.videoHeight;
    setFrameAspect(video.videoWidth, video.videoHeight);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (result.landmarks && result.landmarks.length > 0) {
      this.noPoseSince = 0;
      const lm = result.landmarks[0];
      this.drawSkeleton(lm);
      this.processExercise(lm);
    } else {
      this.handleNoPose(now);
    }
    this.drawEquipmentBoxes(this.stableEquipment);
  },

  /** No person detected: say so after a short grace period instead of leaving stale cues. */
  handleNoPose(now = performance.now()) {
    if (!this.noPoseSince) this.noPoseSince = now;
    if (now - this.noPoseSince < NO_POSE_GRACE_MS) return;
    this.smoothedAngle = null;
    this.phaseFrames = 0;
    const feedbackEl = document.getElementById("camera-feedback");
    if (feedbackEl) feedbackEl.textContent = "I can't see you. Step back so your whole body is in the camera view.";
    const angleEl = document.getElementById("vision-angle");
    if (angleEl) angleEl.textContent = "-- deg";
  },

  startCrowdAnalysis() {
    const card = document.getElementById("crowd-analysis-card");
    if (card) card.style.display = "block";
    this.renderCrowdState("Connecting to Roboflow people counting…", null, "Waiting");
    this.scheduleCrowdAnalysis(0);
  },

  scheduleCrowdAnalysis(delay = this.crowdIntervalMs) {
    if (!this.running) return;
    if (this.crowdTimer) window.clearTimeout(this.crowdTimer);
    this.crowdTimer = window.setTimeout(() => this.analyzeCrowdFrame(), delay);
  },

  async analyzeCrowdFrame() {
    if (!this.running) return;
    if (this.crowdRequestInFlight || this.video.readyState < 2 || !this.video.videoWidth) {
      this.scheduleCrowdAnalysis();
      return;
    }
    this.crowdRequestInFlight = true;
    const canvas = this.crowdCanvas;
    const scale = Math.min(1, 640 / Math.max(this.video.videoWidth, this.video.videoHeight));
    canvas.width = Math.max(1, Math.round(this.video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(this.video.videoHeight * scale));
    canvas.getContext("2d").drawImage(this.video, 0, 0, canvas.width, canvas.height);
    const imageBase64 = canvas.toDataURL("image/jpeg", 0.62).split(",")[1];
    try {
      const result = await Api.post("/equipment/crowd-analysis", { imageBase64 }, { timeoutMs: 12000 });
      if (!result.configured) {
        this.renderCrowdState("Crowd analysis is not configured.", null, "Unavailable");
      } else {
        this.renderCrowdState(
          "Live crowd estimate · Roboflow people counting",
          Number(result.peopleCount),
          String(result.crowdLevel || "Analyzed"),
          result.occupancy || "People count is an estimate, not a machine-level availability signal."
        );
      }
    } catch (error) {
      this.renderCrowdState(error?.message || "Crowd analysis is temporarily unavailable. Retrying…", null, "Unavailable");
    } finally {
      this.crowdRequestInFlight = false;
      this.scheduleCrowdAnalysis();
    }
  },

  renderCrowdState(status, count, level, note = "Machine-level occupancy is not confirmed by people counting.") {
    const statusEl = document.getElementById("crowd-analysis-status");
    const countEl = document.getElementById("crowd-people-count");
    const levelEl = document.getElementById("crowd-level");
    const resultsEl = document.getElementById("crowd-analysis-results");
    if (statusEl) statusEl.textContent = status;
    if (countEl) countEl.textContent = Number.isFinite(count) ? String(count) : "—";
    if (levelEl) levelEl.textContent = level;
    if (resultsEl) resultsEl.textContent = note;
  },

  startEquipmentRecognition() {
    const card = document.getElementById("equipment-recognition-card");
    card.style.display = "block";
    this.renderEquipmentState("Analyzing camera frames…", []);
    this.scheduleEquipmentRecognition(0);
  },

  scheduleEquipmentRecognition(delay = this.equipmentIntervalMs) {
    if (!this.running) return;
    this.equipmentTimer = window.setTimeout(() => this.analyzeEquipmentFrame(), delay);
  },

  async analyzeEquipmentFrame() {
    if (!this.running) return;
    if (this.equipmentRequestInFlight || this.video.readyState < 2 || !this.video.videoWidth) {
      this.scheduleEquipmentRecognition();
      return;
    }

    this.equipmentRequestInFlight = true;
    const canvas = this.equipmentCanvas;
    canvas.width = this.video.videoWidth;
    canvas.height = this.video.videoHeight;
    canvas.getContext("2d").drawImage(this.video, 0, 0, canvas.width, canvas.height);
    const imageBase64 = canvas.toDataURL("image/jpeg", 0.8).split(",")[1];

    try {
      const result = await Api.post("/equipment/detect", { imageBase64 });
      if (!result.configured) {
        this.renderEquipmentState("Model not configured. Add a trained local YOLO model to the backend.", []);
      } else {
        const detections = (result.detections || []).filter(
          (d) => Number(d.confidence) >= this.equipmentMinConfidence,
        );
        this.updateEquipmentSmoothing(detections);
        this.renderEquipmentState(
          this.stableEquipment.length ? "Equipment recognized" : "Equipment not confidently recognized. Please point the camera at the equipment.",
          this.stableEquipment,
          result.suggestedExercises || [],
        );
      }
    } catch (_error) {
      this.renderEquipmentState("Unable to analyze frame. Retrying…", this.stableEquipment);
    } finally {
      this.equipmentRequestInFlight = false;
      this.scheduleEquipmentRecognition();
    }
  },

  updateEquipmentSmoothing(detections) {
    const labels = detections.map((d) => d.equipmentName).sort().join("|");
    this.equipmentHistory.push({ labels, detections });
    if (this.equipmentHistory.length > 3) this.equipmentHistory.shift();
    const matching = this.equipmentHistory.filter((entry) => entry.labels === labels);
    if (matching.length >= 2) this.stableEquipment = matching[matching.length - 1].detections;
  },

  drawEquipmentBoxes(detections) {
    const width = this.canvas.width;
    const height = this.canvas.height;
    this.ctx.strokeStyle = "#ffd166";
    this.ctx.fillStyle = "#ffd166";
    this.ctx.lineWidth = 3;
    detections.forEach((detection) => {
      const box = detection.boundingBox;
      if (!box) return;
      const normalized = [box.x, box.y, box.width, box.height].every((value) => value >= 0 && value <= 1);
      const scaleX = normalized ? width : 1;
      const scaleY = normalized ? height : 1;
      const x = (box.x - box.width / 2) * scaleX;
      const y = (box.y - box.height / 2) * scaleY;
      const w = box.width * scaleX;
      const h = box.height * scaleY;
      this.ctx.strokeRect(x, y, w, h);
      this.ctx.font = "600 16px sans-serif";
      this.ctx.fillText(`${detection.equipmentName} ${Math.round(detection.confidence * 100)}%`, x + 4, Math.max(18, y - 6));
    });
  },

  renderEquipmentState(status, detections, recommendations = []) {
    const statusEl = document.getElementById("equipment-recognition-status");
    const resultsEl = document.getElementById("equipment-recognition-results");
    const recommendationsEl = document.getElementById("equipment-recommendations");
    if (!statusEl || !resultsEl || !recommendationsEl) return;
    statusEl.textContent = status;
    resultsEl.innerHTML = detections
      .map((detection) => `<span class="pill" style="margin:6px 6px 0 0; display:inline-block;">${detection.equipmentName} · ${Math.round(detection.confidence * 100)}%</span>`)
      .join("");
    recommendationsEl.innerHTML = recommendations.length
      ? `<div class="card-label" style="margin-top:12px;">Recommended with this equipment</div>${recommendations
          .slice(0, 4)
          .map((exercise) => `<div class="exercise-meta">${exercise.name} · ${exercise.sets} × ${exercise.repRangeLow}-${exercise.repRangeHigh}</div>`)
          .join("")}`
      : "";
  },

  drawSkeleton(lm) {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const connections = [
      [11, 13], [13, 15], [12, 14], [14, 16],
      [11, 12], [11, 23], [12, 24], [23, 24],
      [23, 25], [25, 27], [24, 26], [26, 28],
    ];
    this.ctx.strokeStyle = "#86e3c4";
    this.ctx.lineWidth = 4;
    connections.forEach(([a, b]) => {
      if (!lm[a] || !lm[b]) return;
      this.ctx.beginPath();
      this.ctx.moveTo(lm[a].x * w, lm[a].y * h);
      this.ctx.lineTo(lm[b].x * w, lm[b].y * h);
      this.ctx.stroke();
    });
    this.ctx.fillStyle = "#ffffff";
    Object.values(LANDMARK).forEach((idx) => {
      const p = lm[idx];
      if (!p) return;
      this.ctx.beginPath();
      this.ctx.arc(p.x * w, p.y * h, 5, 0, Math.PI * 2);
      this.ctx.fill();
    });
  },

  /* ---------------------- form comparison ---------------------- */

  /**
   * Whether the comparison feature should be offered at all. Runs once when the
   * camera starts and again on an explicit Retry; it never blocks the camera,
   * rep counting, or equipment recognition.
   */
  async refreshComparisonStatus(manual) {
    if (manual) {
      this.showComparisonCard();
      this.setComparisonRetryVisible(false);
      this.renderComparisonNotice("Checking form analysis…");
    }

    try {
      const status = await Api.get("/comparison/status");
      this.comparison.configured = Boolean(status?.configured);
      this.comparison.available = Boolean(status?.available);
    } catch (_error) {
      // The status probe failed, which means our own backend or the network is
      // down. Fail closed for this feature only; nothing else is affected.
      this.comparison.configured = null;
      this.comparison.available = false;
    }

    this.showComparisonCard();
    if (this.comparison.available) {
      this.renderComparisonNotice(
        `${EXERCISE_CONFIG[this.currentExercise]?.label || this.coachExerciseName || "Exercise"}: complete one repetition to set your baseline.`,
      );
      this.setComparisonRetryVisible(false);
      return;
    }
    this.renderComparisonResults(null);
    this.renderComparisonNotice(COMPARISON_UNAVAILABLE_MESSAGE);
    this.setComparisonRetryVisible(true);
  },

  retryComparison() {
    if (this.comparison.lastReference && this.comparison.lastFrames) {
      void this.analyzePair(this.comparison.lastReference, this.comparison.lastFrames);
      return;
    }
    void this.refreshComparisonStatus(true);
  },

  beginRepCapture() {
    this.comparison.currentFrames = [];
    this.comparison.frameCounter = 0;
    this.comparison.capturing = true;
  },

  /** Samples every other processed frame and hard-caps the rep before sending. */
  captureRepFrame(lm) {
    if (this.comparison.currentFrames.length >= MAX_CAPTURED_FRAMES) return;
    this.comparison.frameCounter += 1;
    if (this.comparison.frameCounter % FRAME_SAMPLE_STRIDE !== 0) return;
    this.comparison.currentFrames.push(flattenLandmarks(lm));
  },

  completeRep() {
    const frames = this.comparison.currentFrames;
    this.comparison.capturing = false;
    this.comparison.currentFrames = [];
    this.comparison.frameCounter = 0;

    // Too few samples to describe a movement — ignore instead of sending junk.
    if (frames.length < 4) return;

    if (!this.comparison.baselineFrames) {
      this.comparison.baselineFrames = frames;
      this.renderComparisonNotice("Baseline repetition captured. Do one more repetition for form feedback.");
      return;
    }
    void this.submitComparison(frames);
  },

  async submitComparison(frames) {
    const reference = this.comparison.baselineFrames;
    if (!reference) return;
    // Only the automatic path is gated: an explicit Retry may still succeed
    // after a status probe reported the service as unavailable.
    if (this.comparison.available === false || this.comparison.unsupported) return;
    this.comparison.lastReference = reference;
    this.comparison.lastFrames = frames;
    await this.analyzePair(reference, frames);
  },

  async analyzePair(reference, frames) {
    // Guards against a duplicate submission while one analysis is still running.
    if (this.comparison.inFlight) return;
    if (!reference || reference.length < 2 || frames.length < 2) return;

    const targetCount = Math.min(MAX_SUBMITTED_FRAMES, reference.length, frames.length);
    this.comparison.inFlight = true;
    this.showComparisonCard();
    this.renderComparisonResults(null);
    this.setComparisonRetryVisible(false);
    this.renderComparisonNotice("Analyzing your form…");

    try {
      const result = await Api.post(
        "/comparison/analyze",
        {
          exerciseKey: this.currentExercise,
          exerciseName: EXERCISE_CONFIG[this.currentExercise].label,
          referenceSequence: resampleFrames(reference, targetCount),
          sequence: resampleFrames(frames, targetCount),
        },
        { timeoutMs: 15000 },
      );

      if (result && result.analysis) {
        this.renderComparisonResults(result.analysis);
        this.renderComparisonNotice("");
      } else {
        this.renderComparisonNotice(COMPARISON_NO_RESULT_MESSAGE);
        this.setComparisonRetryVisible(true);
      }
    } catch (error) {
      this.handleComparisonError(error);
    } finally {
      this.comparison.inFlight = false;
    }
  },

  /** A single failure never disables the feature permanently — only the id list. */
  handleComparisonError(error) {
    const backendMessage = typeof error?.body?.error === "string" ? error.body.error : null;

    if (error?.status === 422) {
      // The service does not support this movement, so stop offering analysis
      // for it until the exercise selection changes.
      this.comparison.unsupported = true;
      this.renderComparisonNotice(backendMessage || COMPARISON_NO_RESULT_MESSAGE);
      this.setComparisonRetryVisible(false);
      return;
    }
    if (error?.status === 400 || error?.status === 429) {
      this.renderComparisonNotice(backendMessage || COMPARISON_NO_RESULT_MESSAGE);
      this.setComparisonRetryVisible(true);
      return;
    }
    // 502 / 503 / 504 and transport failures all mean "the feature is
    // temporarily unavailable" from the user's point of view.
    this.renderComparisonNotice(backendMessage || COMPARISON_UNAVAILABLE_MESSAGE);
    this.setComparisonRetryVisible(true);
  },

  showComparisonCard() {
    const card = document.getElementById("form-comparison-card");
    if (card) card.style.display = "block";
  },

  hideComparisonCard() {
    const card = document.getElementById("form-comparison-card");
    if (card) card.style.display = "none";
  },

  setComparisonRetryVisible(visible) {
    const button = document.getElementById("form-comparison-retry-btn");
    if (button) button.style.display = visible ? "inline-flex" : "none";
  },

  renderComparisonNotice(text) {
    const status = document.getElementById("form-comparison-status");
    if (status) status.textContent = text || "";
  },

  /**
   * Renders only what the service actually returned. A missing score, an empty
   * difference list, or an absent confidence value simply omits that block — no
   * placeholder, no invented figure, no raw payload.
   */
  renderComparisonResults(analysis) {
    const results = document.getElementById("form-comparison-results");
    if (!results) return;
    if (!analysis) {
      results.innerHTML = "";
      return;
    }

    const blocks = [];

    if (analysis.formScorePercent !== null && analysis.formScorePercent !== undefined) {
      blocks.push(
        `<div class="comparison-score"><span class="comparison-score-value">${escapeText(analysis.formScorePercent)}%</span>` +
        `<span class="comparison-score-label">form match against your baseline repetition</span></div>`,
      );
    } else if (analysis.formScore !== null && analysis.formScore !== undefined) {
      blocks.push(
        `<div class="comparison-score"><span class="comparison-score-value">${escapeText(analysis.formScore)}</span>` +
        `<span class="comparison-score-label">form score reported by the analysis</span></div>`,
      );
    }

    // Uncertain results are labelled rather than presented as definitive.
    if (typeof analysis.confidence === "number" && analysis.confidence < 0.6) {
      blocks.push(`<p class="comparison-caveat">Low confidence reading (${escapeText(Math.round(analysis.confidence * 100))}%). Treat this as a rough guide.</p>`);
    }

    if (analysis.summary) {
      blocks.push(`<p class="comparison-summary">${escapeText(analysis.summary)}</p>`);
    }

    if (Array.isArray(analysis.differences) && analysis.differences.length) {
      const items = analysis.differences.map((difference) => {
        const title = difference.part ? escapeText(difference.part) : "Reported difference";
        const details = [];
        if (difference.detail) details.push(escapeText(difference.detail));
        if (difference.deviation !== null && difference.deviation !== undefined) {
          details.push(`reported deviation ${escapeText(difference.deviation)}`);
        }
        return `<li class="comparison-difference"><strong>${title}</strong>${details.length ? `<span>${details.join(" · ")}</span>` : ""}</li>`;
      }).join("");
      blocks.push(`<div class="comparison-block"><div class="card-label">Detected differences</div><ul class="comparison-list">${items}</ul></div>`);
    }

    if (Array.isArray(analysis.corrections) && analysis.corrections.length) {
      const items = analysis.corrections.map((correction) => `<li>${escapeText(correction)}</li>`).join("");
      blocks.push(`<div class="comparison-block"><div class="card-label">What to adjust</div><ul class="comparison-list">${items}</ul></div>`);
    }

    results.innerHTML = blocks.join("");
  },

  /* ---------------------- pose + rep pipeline ---------------------- */

  /**
   * Debounces the on-screen cue: a different cue must persist for several
   * frames and the current one must have been visible for a minimum time, so
   * the text does not flicker on every frame.
   */
  stabilizeCue(text) {
    const cue = this.cue;
    const now = performance.now();
    if (text === cue.shown) { cue.candidate = text; cue.count = 0; return cue.shown; }
    if (text !== cue.candidate) { cue.candidate = text; cue.count = 1; } else cue.count += 1;
    if (!cue.shown || (cue.count >= CUE_CONFIRM_FRAMES && now - cue.shownAt >= CUE_MIN_HOLD_MS)) {
      cue.shown = text; cue.shownAt = now; cue.count = 0;
    }
    return cue.shown;
  },

  /** Framing / visibility problems are shown immediately and are never mixed with form cues. */
  showFramingMessage(text) {
    const feedbackEl = document.getElementById("camera-feedback");
    this.cue = { candidate: text, count: 0, shown: text, shownAt: performance.now() };
    if (feedbackEl) feedbackEl.textContent = text;
  },

  freshAiFeedback() {
    return this.coachFeedback && performance.now() - this.coachFeedbackAt < AI_FEEDBACK_TTL_MS ? this.coachFeedback : "";
  },

  processExercise(lm) {
    const feedbackEl = document.getElementById("camera-feedback");
    const config = EXERCISE_CONFIG[this.currentExercise];
    this.collectCoachFrame(lm);

    if (!config) {
      if (feedbackEl) feedbackEl.textContent = this.trackingReason && !this.freshAiFeedback()
        ? `${this.trackingReason} Pose tracking is active; rep counting is not enabled for this movement.`
        : this.freshAiFeedback() || (this.aiCoachAvailable === false
          ? FRAMING_MESSAGE_UNSUPPORTED
          : "Analyzing this exercise with the shared coach. Keep your full body visible and move at a controlled pace.");
      return;
    }
    if (config.hold) {
      if (hasVisiblePose(lm, config.required)) {
        activeSide = bestSide(lm, config.required);
        if (feedbackEl) feedbackEl.textContent = config.feedback(0, "up", lm);
        const angleEl = document.getElementById("vision-angle");
        if (angleEl) angleEl.textContent = "hold";
      } else {
        this.showFramingMessage("Keep your shoulders, hips and ankles visible; stand side-on to the camera.");
      }
      return;
    }
    if (!hasVisiblePose(lm, config.required)) {
      // Do not reset phase/rep state here: a brief occlusion must not erase a
      // rep in progress. Only the smoothing window restarts.
      this.smoothedAngle = null;
      this.phaseFrames = 0;
      this.showFramingMessage(this.currentExercise === "squat"
        ? "Keep your hips, knees and at least one ankle visible. Step back slightly and improve lighting if needed."
        : this.currentExercise === "curl"
          ? "Keep one shoulder, elbow, wrist and hip visible. Turn slightly sideways and improve lighting if needed."
          : this.currentExercise === "seatedrow"
            ? "Turn side-on to the camera and keep your shoulder, elbow, wrist and hip visible."
            : "Keep your shoulders, elbows, wrists, hips and ankles visible. Step back and improve lighting if needed.");
      return;
    }

    activeSide = bestSide(lm, config.required);
    const raw = config.angleOf(lm);
    const angle = this.smoothedAngle === null
      ? raw
      : this.smoothedAngle * (1 - ANGLE_SMOOTHING) + raw * ANGLE_SMOOTHING;
    this.smoothedAngle = angle;
    document.getElementById("vision-angle").textContent = `${Math.round(angle)} deg`;

    let target = null;
    if (this.phase === "up" && angle < config.downThreshold) target = "down";
    else if (this.phase === "down" && angle > config.upThreshold) target = "up";
    this.phaseFrames = target ? this.phaseFrames + 1 : 0;
    if (target && this.phaseFrames >= PHASE_CONFIRM_FRAMES) {
      this.phaseFrames = 0;
      if (target === "down") {
        this.phase = "down";
        this.beginRepCapture();
      } else {
        this.phase = "up";
        this.repCount += 1;
        document.getElementById("vision-reps").textContent = String(this.repCount);
        this.captureRepFrame(lm);
        this.completeRep();
      }
    }
    if (this.comparison.capturing) this.captureRepFrame(lm);
    if (feedbackEl) feedbackEl.textContent = this.stabilizeCue(config.feedback(angle, this.phase, lm));
  },

  collectCoachFrame(landmarks) {
    // Server AI is only used for exercises without built-in rules, and only when
    // the backend reports a configured model. Supported exercises are coached by
    // the on-device rules, so no camera frames are uploaded for them.
    const useAi = !EXERCISE_CONFIG[this.currentExercise] && this.aiCoachAvailable === true;
    if (!useAi) return;
    const now = performance.now();
    if (now - this.coachLastSampleAt >= 350) {
      this.coachLastSampleAt = now;
      this.coachFrameBuffer.push(landmarks.map((point) => ({
        x: point.x, y: point.y, z: point.z, visibility: point.visibility ?? 1,
      })));
      if (this.coachFrameBuffer.length > 24) this.coachFrameBuffer.shift();
    }
    if (!this.coachRequestInFlight && this.coachFrameBuffer.length >= 8 && now - this.coachLastRequestAt >= 4500) {
      void this.requestUniversalCoachAnalysis();
    }
    if (!this.coachIdentifyInFlight && now - this.coachLastIdentifyAt >= 10000) {
      void this.identifyUniversalExercise();
    }
  },

  async requestUniversalCoachAnalysis() {
    if (!this.running || this.coachRequestInFlight || this.coachFrameBuffer.length < 8) return;
    this.coachRequestInFlight = true;
    this.coachLastRequestAt = performance.now();
    const frames = this.coachFrameBuffer.slice(-16);
    try {
      const cameraCanvas = document.createElement("canvas");
      const videoWidth = this.video.videoWidth || 0;
      const videoHeight = this.video.videoHeight || 0;
      const images = [];
      if (videoWidth > 0 && videoHeight > 0 && this.video.readyState >= 2) {
        cameraCanvas.width = Math.min(640, videoWidth);
        cameraCanvas.height = Math.round(videoHeight * cameraCanvas.width / videoWidth);
        cameraCanvas.getContext("2d").drawImage(this.video, 0, 0, cameraCanvas.width, cameraCanvas.height);
        images.push({
          mimeType: "image/jpeg",
          data: cameraCanvas.toDataURL("image/jpeg", 0.55).split(",")[1],
        });
      }
      const result = await Api.post("/coach/analyze", {
        exerciseName: this.coachExerciseName,
        equipment: this.stableEquipment.map((item) => item.name).filter(Boolean).slice(0, 10),
        goal: "general_fitness",
        frames,
        images,
      }, { timeoutMs: 18000 });
      const cues = Array.isArray(result?.feedback)
        ? result.feedback.map((item) => typeof item?.cue === "string" ? item.cue.trim() : "").filter(Boolean).slice(0, 2)
        : [];
      if (result?.modelConfigured === false) {
        // Fallback text from the server is generic, not coaching from the user's movement.
        this.aiCoachAvailable = false;
        this.coachFeedback = "";
      } else if (cues.length && Number(result?.confidence ?? 0) >= 0.45) {
        this.coachFeedback = cues.join(" ");
        this.coachFeedbackAt = performance.now();
      } else if (result?.needsRepositioning) {
        this.coachFeedback = "Move fully into frame and improve lighting so the coach can see your movement.";
        this.coachFeedbackAt = performance.now();
      } else if (result?.exerciseHypothesis === "unknown") {
        this.coachFeedback = "I couldn't identify this movement confidently. Keep your full body visible or select the exercise by name.";
        this.coachFeedbackAt = performance.now();
      }
    } catch (error) {
      if (error?.status === 401) { this.coachFeedback = "Please sign in again to use live AI coaching."; this.coachFeedbackAt = performance.now(); }
      else if (error?.status === 503) { this.aiCoachAvailable = false; this.coachFeedback = ""; }
      console.warn("[VisionCoach] universal coaching request failed", error?.message || error);
    } finally {
      this.coachRequestInFlight = false;
    }
  },

  async identifyUniversalExercise() {
    if (!this.running || this.coachIdentifyInFlight || this.video.readyState < 2 || !this.video.videoWidth) return;
    this.coachIdentifyInFlight = true;
    this.coachLastIdentifyAt = performance.now();
    try {
      const canvas = this.equipmentCanvas;
      canvas.width = Math.min(640, this.video.videoWidth);
      canvas.height = Math.round(this.video.videoHeight * canvas.width / this.video.videoWidth);
      canvas.getContext("2d").drawImage(this.video, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL("image/jpeg", 0.65).split(",")[1];
      const result = await Api.post("/coach/identify-exercise", {
        frames: [{ mimeType: "image/jpeg", data }],
        equipment: this.stableEquipment.map((item) => item.name).filter(Boolean).slice(0, 10),
      }, { timeoutMs: 20000 });
      if (typeof result?.exerciseHypothesis === "string" && result.exerciseHypothesis !== "unknown" && Number(result.confidence ?? 0) >= 0.55) {
        this.coachExerciseName = result.exerciseHypothesis;
        const status = document.getElementById("form-comparison-status");
        if (status) status.textContent = `AI identified: ${result.exerciseHypothesis}. This is context, not proof of correct form.`;
      }
    } catch (error) {
      console.warn("[VisionCoach] exercise identification unavailable", error?.message || error);
    } finally {
      this.coachIdentifyInFlight = false;
    }
  },
};

window.VisionCoach = VisionCoach;
window.addEventListener("DOMContentLoaded", () => VisionCoach.init());
