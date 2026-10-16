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

function angleBetween(a, b, c) {
  // angle at point b, formed by rays b->a and b->c, in degrees
  const ab = { x: a.x - b.x, y: a.y - b.y };
  const cb = { x: c.x - b.x, y: c.y - b.y };
  const dot = ab.x * cb.x + ab.y * cb.y;
  const magAB = Math.hypot(ab.x, ab.y);
  const magCB = Math.hypot(cb.x, cb.y);
  if (magAB === 0 || magCB === 0) return 0;
  const cos = Math.min(1, Math.max(-1, dot / (magAB * magCB)));
  return (Math.acos(cos) * 180) / Math.PI;
}

function pick(landmarks, leftIdx, rightIdx) {
  const l = landmarks[leftIdx];
  const r = landmarks[rightIdx];
  // Prefer whichever side the model is more confident about (higher visibility).
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
const MIN_LANDMARK_VISIBILITY = 0.5;

/** True when at least one of the left/right landmarks of every joint group is usable. */
function hasVisiblePose(lm, groups) {
  return groups.every(([left, right]) =>
    [left, right].some((index) => {
      const point = lm[index];
      return Boolean(point) && (point.visibility ?? 1) >= MIN_LANDMARK_VISIBILITY;
    }));
}

/** Degrees a segment (top -> bottom) is tilted away from vertical; 0 = straight up/down. */
function tiltFromVertical(top, bottom) {
  const dx = bottom.x - top.x;
  const dy = bottom.y - top.y;
  return (Math.atan2(Math.abs(dx), Math.abs(dy)) * 180) / Math.PI;
}

/**
 * Perpendicular distance between a point and the torso line (shoulder -> hip),
 * as a fraction of torso length. 0 means the point sits exactly on the torso
 * line; larger values mean the point has drifted away from the body.
 */
function torsoLineOffset(point, shoulder, hip) {
  const dx = hip.x - shoulder.x;
  const dy = hip.y - shoulder.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return 0;
  const px = point.x - shoulder.x;
  const py = point.y - shoulder.y;
  return Math.abs(px * dy - py * dx) / (length * length);
}

/**
 * Signed vertical position of the hip relative to the shoulder -> ankle line,
 * as a fraction of shoulder-to-ankle distance. Positive = hips below the line
 * (sagging); negative = hips above the line (piking).
 */
function hipLineDeviation(shoulder, hip, ankle) {
  const dx = ankle.x - shoulder.x;
  const dy = ankle.y - shoulder.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return 0;
  const t = dx === 0 ? 0 : (hip.x - shoulder.x) / dx;
  const lineY = shoulder.y + dy * t;
  return (hip.y - lineY) / length;
}

function coachKeyFor(name = "") {
  const n = String(name).toLowerCase();
  if (/squat/.test(n)) return "squat";
  if (/curl/.test(n)) return "curl";
  if (/bent.?over.?row|barbell.?row|dumbbell.?row|seated.?row|cable.?row|one.?arm.?row|\browing\b/.test(n)) return "row";
  if (/push.?up|press.?up/.test(n)) return "pushup";
  return null;
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
      if (torsoAngle < 25) return "Hinge forward from your hips and keep your back neutral";
      if (torsoAngle > 100) return "Keep your torso hinged forward and steady";
      if (phase === "down" && angle > 90) return "Pull your elbows back and bring the weight toward your lower ribs";
      if (phase === "down") return "Squeeze your shoulder blades without jerking your torso";
      return "Lower your arms with control, keeping your torso still";
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

const VisionCoach = {
  landmarker: null,
  running: false,
  currentExercise: "squat",
  repCount: 0,
  phase: "up", // "up" | "down"
  video: null,
  canvas: null,
  ctx: null,
  equipmentCanvas: null,
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
  },

  async openFor(exercise) {
    const exerciseName = String(exercise?.exerciseName || exercise?.name || "Unknown exercise");
    const key = coachKeyFor(exerciseName);
    const placeholder = document.getElementById("camera-placeholder");
    const demoSection = document.getElementById("vision-demo");
    if (demoSection) demoSection.hidden = false;

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
      : `AI coaching for ${exerciseName}: keep your full body in frame. Sampled pose data and occasional camera frames may be sent to FitOS for AI analysis. Feedback depends on model confidence.`;
    document.querySelectorAll("#vision-segment button").forEach((button) => {
      button.classList.toggle("active", Boolean(key) && button.dataset.exercise === key);
    });
    this.resetReps();
    if (!this.running) await this.start();
  },

  resetReps() {
    this.repCount = 0;
    this.phase = "up";
    document.getElementById("vision-reps").textContent = "0";
    document.getElementById("vision-angle").textContent = "0 deg";
    this.resetComparisonCapture();
    const label = EXERCISE_CONFIG[this.currentExercise]?.label || this.coachExerciseName || "Exercise";
    this.renderComparisonNotice(`${label}: live pose analysis is active. AI feedback depends on backend configuration and model confidence.`);
  },

  resetComparisonCapture() {
    this.comparison.capturing = false;
    this.comparison.frameCounter = 0;
    this.comparison.currentFrames = [];
    this.comparison.baselineFrames = null;
    this.comparison.unsupported = false;
    this.renderComparisonResults(null);
  },

  async start() {
    const placeholder = document.getElementById("camera-placeholder");
    const startBtn = document.getElementById("vision-start-btn");
    startBtn.disabled = true;
    startBtn.innerHTML = `<span class="spinner"></span> Loading model…`;

    try {
      if (!this.landmarker) {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
        );
        this.landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numPoses: 1,
        });
      }

      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
      this.video.srcObject = stream;
      this.video.style.display = "block";
      await this.video.play();
      placeholder.style.display = "none";
      document.getElementById("camera-feedback").style.display = "block";

      startBtn.textContent = "Stop Camera";
      startBtn.disabled = false;

      this.running = true;
      this.startEquipmentRecognition();
      this.loop();
      this.showComparisonCard();
      this.setComparisonRetryVisible(false);
      this.renderComparisonNotice("Live coaching is analyzing your movement. AI feedback requires GEMINI_API_KEY on the backend; the old reference-comparison service is separate.");
    } catch (e) {
      placeholder.textContent =
        "Couldn't start the camera or load the pose model (needs internet + camera permission). " + e.message;
      startBtn.disabled = false;
      startBtn.textContent = "Start Camera";
      // Without pose detection there is nothing to compare, so the comparison
      // panel is cleared rather than left showing a stale result.
      this.resetComparisonCapture();
      this.hideComparisonCard();
    }
  },

  stop() {
    this.running = false;
    this.coachFrameBuffer = [];
    this.coachFeedback = "";
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
    this.video.style.display = "none";
    document.getElementById("camera-placeholder").style.display = "flex";
    document.getElementById("camera-placeholder").textContent = 'Tap "Start Camera" to begin pose analysis.';
    document.getElementById("camera-feedback").style.display = "none";
    const startBtn = document.getElementById("vision-start-btn");
    startBtn.textContent = "Start Camera";
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.renderEquipmentState("Waiting for a frame…", []);
  },

  loop() {
    if (!this.running) return;
    const now = performance.now();
    if (this.video.readyState >= 2) {
      const result = this.landmarker.detectForVideo(this.video, now);
      this.canvas.width = this.video.videoWidth;
      this.canvas.height = this.video.videoHeight;
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

      if (result.landmarks && result.landmarks.length > 0) {
        const lm = result.landmarks[0];
        this.drawSkeleton(lm);
        this.processExercise(lm);
      }
      this.drawEquipmentBoxes(this.stableEquipment);
    }
    requestAnimationFrame(() => this.loop());
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

  processExercise(lm) {
    const feedbackEl = document.getElementById("camera-feedback");
    const config = EXERCISE_CONFIG[this.currentExercise];
    this.collectCoachFrame(lm);

    if (!config) {
      if (feedbackEl) feedbackEl.textContent = this.coachFeedback ||
        "Analyzing this exercise with the shared coach. Keep your full body visible and move at a controlled pace.";
      return;
    }
    if (!hasVisiblePose(lm, config.required)) {
      if (feedbackEl) feedbackEl.textContent = "Move fully into frame so your body is clearly visible.";
      return;
    }

    const angle = config.angleOf(lm);
    document.getElementById("vision-angle").textContent = `${Math.round(angle)} deg`;
    if (this.phase === "up" && angle < config.downThreshold) {
      this.phase = "down";
      this.beginRepCapture();
    } else if (this.phase === "down" && angle > config.upThreshold) {
      this.phase = "up";
      this.repCount += 1;
      document.getElementById("vision-reps").textContent = String(this.repCount);
      this.captureRepFrame(lm);
      this.completeRep();
    }
    if (this.comparison.capturing) this.captureRepFrame(lm);
    if (feedbackEl) feedbackEl.textContent = this.coachFeedback || config.feedback(angle, this.phase, lm);
  },

  collectCoachFrame(landmarks) {
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
    if (!EXERCISE_CONFIG[this.currentExercise] && !this.coachIdentifyInFlight && now - this.coachLastIdentifyAt >= 10000) {
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
      if (cues.length && (Number(result?.confidence ?? 0) >= 0.45 || result?.modelConfigured === false)) {
        this.coachFeedback = cues.join(" ");
      } else if (result?.needsRepositioning) {
        this.coachFeedback = "Move fully into frame and improve lighting so the coach can see your movement.";
      } else if (result?.exerciseHypothesis === "unknown") {
        this.coachFeedback = "I couldn't identify this movement confidently. Keep your full body visible or select the exercise by name.";
      }
    } catch (error) {
      if (error?.status === 401) this.coachFeedback = "Please sign in again to use live AI coaching.";
      else if (error?.status === 503) this.coachFeedback = "AI coaching is not configured on the backend yet; basic pose tracking remains available.";
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
