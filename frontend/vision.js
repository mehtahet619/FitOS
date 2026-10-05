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

const EXERCISE_CONFIG = {
  squat: {
    label: "Squat",
    angleOf(lm) {
      const hip = pick(lm, LANDMARK.LEFT_HIP, LANDMARK.RIGHT_HIP);
      const knee = pick(lm, LANDMARK.LEFT_KNEE, LANDMARK.RIGHT_KNEE);
      const ankle = pick(lm, LANDMARK.LEFT_ANKLE, LANDMARK.RIGHT_ANKLE);
      return angleBetween(hip, knee, ankle);
    },
    upThreshold: 160,   // standing
    downThreshold: 100, // bottom of squat
    feedback(angle, phase) {
      if (phase === "down" && angle > 110) return "Go a little lower";
      if (phase === "down") return "Good depth";
      return "Stand tall, then squat down";
    },
  },
  curl: {
    label: "Curl",
    angleOf(lm) {
      const shoulder = pick(lm, LANDMARK.LEFT_SHOULDER, LANDMARK.RIGHT_SHOULDER);
      const elbow = pick(lm, LANDMARK.LEFT_ELBOW, LANDMARK.RIGHT_ELBOW);
      const wrist = pick(lm, LANDMARK.LEFT_WRIST, LANDMARK.RIGHT_WRIST);
      return angleBetween(shoulder, elbow, wrist);
    },
    upThreshold: 150, // arm extended
    downThreshold: 50, // fully curled
    feedback(angle, phase) {
      if (phase === "down" && angle > 60) return "Curl a bit higher";
      if (phase === "down") return "Nice squeeze";
      return "Extend fully between reps";
    },
  },
  pushup: {
    label: "Push-up",
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
      const bodyLine = angleBetween(shoulder, hip, ankle);
      if (bodyLine < 155) return "Keep your hips up — straighten your back";
      if (phase === "down" && angle > 100) return "Lower your chest more";
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
        this.resetReps();
      });
    });

    document.getElementById("vision-start-btn").addEventListener("click", () => this.start());
    document.getElementById("vision-reset-btn").addEventListener("click", () => this.resetReps());
  },

  resetReps() {
    this.repCount = 0;
    this.phase = "up";
    document.getElementById("vision-reps").textContent = "0";
    document.getElementById("vision-angle").textContent = "0 deg";
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
      startBtn.onclick = () => this.stop();
      startBtn.disabled = false;

      this.running = true;
      this.startEquipmentRecognition();
      this.loop();
    } catch (e) {
      placeholder.textContent =
        "Couldn't start the camera or load the pose model (needs internet + camera permission). " + e.message;
      startBtn.disabled = false;
      startBtn.textContent = "Start Camera";
    }
  },

  stop() {
    this.running = false;
    if (this.equipmentTimer) window.clearTimeout(this.equipmentTimer);
    this.equipmentTimer = null;
    this.equipmentRequestInFlight = false;
    this.equipmentHistory = [];
    this.stableEquipment = [];
    const stream = this.video.srcObject;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    this.video.style.display = "none";
    document.getElementById("camera-placeholder").style.display = "flex";
    document.getElementById("camera-placeholder").textContent = 'Tap "Start Camera" to begin pose analysis.';
    document.getElementById("camera-feedback").style.display = "none";
    const startBtn = document.getElementById("vision-start-btn");
    startBtn.textContent = "Start Camera";
    startBtn.onclick = () => this.start();
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

  processExercise(lm) {
    const config = EXERCISE_CONFIG[this.currentExercise];
    const angle = config.angleOf(lm);
    document.getElementById("vision-angle").textContent = `${Math.round(angle)} deg`;

    // Rep state machine: crossing into "down" then back past "up" = one rep.
    if (this.phase === "up" && angle < config.downThreshold) {
      this.phase = "down";
    } else if (this.phase === "down" && angle > config.upThreshold) {
      this.phase = "up";
      this.repCount += 1;
      document.getElementById("vision-reps").textContent = String(this.repCount);
    }

    const feedbackEl = document.getElementById("camera-feedback");
    feedbackEl.textContent = config.feedback(angle, this.phase, lm);
  },
};

window.addEventListener("DOMContentLoaded", () => VisionCoach.init());
