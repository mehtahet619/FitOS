import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { requireAuth } from "../../common/auth";

export const coachRouter = Router();

const MAX_FRAMES = 8;
const MAX_FRAME_BYTES = 350_000;
const MAX_LANDMARK_FRAMES = 120;
const landmarkSchema = z.object({
  x: z.number().finite().min(-2).max(2),
  y: z.number().finite().min(-2).max(2),
  z: z.number().finite().min(-5).max(5).optional(),
  visibility: z.number().finite().min(0).max(1).optional(),
});
const frameSchema = z.array(landmarkSchema).min(17).max(100);
const analyzeSchema = z.object({
  exerciseName: z.string().trim().max(120).optional(),
  exerciseDescription: z.string().trim().max(500).optional(),
  equipment: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  goal: z.enum(["hypertrophy", "strength", "mobility", "general_fitness", "rehab"]).default("general_fitness"),
  frames: z.array(frameSchema).min(2).max(MAX_LANDMARK_FRAMES),
  images: z.array(z.object({
    mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    data: z.string().min(1).max(MAX_FRAME_BYTES * 2),
  })).max(4).optional(),
});
const identifySchema = z.object({
  frames: z.array(z.object({
    mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    data: z.string().min(1).max(MAX_FRAME_BYTES * 2),
  })).min(1).max(MAX_FRAMES),
  equipment: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
});

const coachLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many coaching requests. Please wait a moment." },
});

function angle(a: z.infer<typeof landmarkSchema>, b: z.infer<typeof landmarkSchema>, c: z.infer<typeof landmarkSchema>): number {
  const ab = { x: a.x - b.x, y: a.y - b.y };
  const cb = { x: c.x - b.x, y: c.y - b.y };
  const dot = ab.x * cb.x + ab.y * cb.y;
  const mag = Math.hypot(ab.x, ab.y) * Math.hypot(cb.x, cb.y);
  if (!mag) return 0;
  return Math.round(Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180 / Math.PI);
}

function summarizePose(frames: Array<Array<z.infer<typeof landmarkSchema>>>) {
  // MediaPipe Pose indices: shoulders 11/12, elbows 13/14, wrists 15/16,
  // hips 23/24, knees 25/26, ankles 27/28.
  const angles = frames.map((points) => {
    const get = (i: number) => points[i];
    const result: Record<string, number | null> = {};
    const measure = (key: string, a: number, b: number, c: number) => {
      const pts = [get(a), get(b), get(c)];
      if (pts.some((p) => !p || (p.visibility ?? 1) < 0.45)) result[key] = null;
      else result[key] = angle(pts[0], pts[1], pts[2]);
    };
    measure("leftElbow", 11, 13, 15);
    measure("rightElbow", 12, 14, 16);
    measure("leftShoulder", 13, 11, 23);
    measure("rightShoulder", 14, 12, 24);
    measure("leftHip", 11, 23, 25);
    measure("rightHip", 12, 24, 26);
    measure("leftKnee", 23, 25, 27);
    measure("rightKnee", 24, 26, 28);
    return result;
  });
  const visibility = frames.map((points) => points.filter((p) => (p.visibility ?? 1) >= 0.45).length / points.length);
  const angleRanges: Record<string, { min: number; max: number; range: number } | null> = {};
  for (const key of Object.keys(angles[0] || {})) {
    const values = angles.map((f) => f[key]).filter((v): v is number => typeof v === "number");
    angleRanges[key] = values.length >= 2
      ? { min: Math.min(...values), max: Math.max(...values), range: Math.max(...values) - Math.min(...values) }
      : null;
  }
  return {
    frameCount: frames.length,
    averageLandmarkVisibility: Number((visibility.reduce((a, b) => a + b, 0) / visibility.length).toFixed(2)),
    angleRanges,
    note: "Angles are 2D estimates from the camera view, not clinical or 3D biomechanical measurements.",
  };
}

async function askGemini(prompt: string, images?: Array<{ mimeType: string; data: string }>) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  for (const image of images || []) {
    parts.push({ inline_data: { mime_type: image.mimeType, data: image.data } });
  }
  const model = process.env.GEMINI_COACH_MODEL || "gemini-2.5-flash";
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
      }),
      signal: AbortSignal.timeout(12_000),
    },
  );
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(`Gemini coaching request failed (${response.status}): ${message.slice(0, 200)}`);
  }
  const payload = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = payload.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
  if (!text) throw new Error("Gemini returned no coaching response");
  return JSON.parse(text) as Record<string, unknown>;
}

coachRouter.get("/status", (_req, res) => {
  res.json({
    status: "ok",
    poseAnalysis: "available",
    multimodalCoach: process.env.GEMINI_API_KEY ? "configured" : "not_configured",
    model: process.env.GEMINI_COACH_MODEL || "gemini-2.5-flash",
    features: ["pose-sequence-summary", "joint-angle-trends", "sampled-frame-exercise-identification", "confidence-aware-feedback"],
  });
});

coachRouter.post("/analyze", requireAuth, coachLimiter, async (req, res) => {
  const parsed = analyzeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid coaching input", details: parsed.error.flatten() });
  const input = parsed.data;
  const imageBytes = (input.images || []).reduce((sum, image) => sum + Math.floor(image.data.length * 3 / 4), 0);
  if (imageBytes > MAX_FRAME_BYTES * 4) return res.status(413).json({ error: "Coaching images exceed the size limit" });
  const pose = summarizePose(input.frames);
  if (pose.averageLandmarkVisibility < 0.45) {
    return res.json({
      exerciseHypothesis: input.exerciseName || null,
      confidence: 0.2,
      feedback: [{ cue: "Move fully into frame and improve lighting before continuing.", reason: "Too few body landmarks are consistently visible.", confidence: 0.95 }],
      pose,
      repCount: null,
      needsRepositioning: true,
      source: "pose-rules",
    });
  }

  const prompt = [
    "You are the cautious movement-coaching assistant inside FitOS.",
    "Use only the supplied exercise context and pose measurements. Do not diagnose injuries or claim certainty from 2D landmarks.",
    "If the exercise is unfamiliar or evidence is insufficient, say so and ask for a clearer view rather than inventing a correction.",
    "Return JSON with keys exerciseHypothesis (string or null), confidence (0..1), feedback (array of objects with cue, reason, confidence), repCount (integer or null), needsRepositioning (boolean), limitations (array of strings).",
    "Give at most 2 concise, actionable cues. Do not treat normal variation as an error.",
    `Exercise: ${input.exerciseName || "unknown"}`,
    `Description: ${input.exerciseDescription || "not provided"}`,
    `Equipment: ${input.equipment.join(", ") || "unknown"}`,
    `Goal: ${input.goal}`,
    `Pose summary: ${JSON.stringify(pose)}`,
  ].join("\n");
  try {
    const result = await askGemini(prompt, input.images);
    if (!result) {
      return res.json({
        exerciseHypothesis: input.exerciseName || null,
        confidence: 0.35,
        feedback: [{ cue: "Keep the movement controlled and capture a full repetition from a clear angle.", reason: "The multimodal coaching model is not configured; only basic pose measurements were calculated.", confidence: 0.6 }],
        pose,
        repCount: null,
        needsRepositioning: false,
        source: "pose-rules",
        modelConfigured: false,
      });
    }
    return res.json({ ...result, pose, source: "gemini+pose", modelConfigured: true });
  } catch (error) {
    console.error("[coach] analysis failed", error);
    return res.status(502).json({ error: "Coaching analysis is temporarily unavailable. Pose measurements were calculated but no model feedback was returned." });
  }
});

coachRouter.post("/identify-exercise", requireAuth, coachLimiter, async (req, res) => {
  const parsed = identifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid exercise-identification input", details: parsed.error.flatten() });
  const input = parsed.data;
  const totalBytes = input.frames.reduce((sum, frame) => sum + Math.floor(frame.data.length * 3 / 4), 0);
  if (totalBytes > MAX_FRAME_BYTES * MAX_FRAMES) return res.status(413).json({ error: "Sampled frames exceed the size limit" });
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: "Exercise identification requires GEMINI_API_KEY.", modelConfigured: false });
  }
  const prompt = [
    "Identify the exercise or movement visible across these sampled frames.",
    "Return JSON with keys exerciseHypothesis (string), confidence (0..1), movementPattern (string or null), visibleEquipment (array of strings), alternativeHypotheses (array of strings), limitations (array of strings).",
    "Do not claim exact form correctness from these frames. If unclear, return 'unknown' with low confidence.",
    `Known equipment context: ${input.equipment.join(", ") || "none provided"}`,
  ].join("\n");
  try {
    const result = await askGemini(prompt, input.frames);
    if (!result) return res.status(503).json({ error: "Multimodal model is not configured." });
    return res.json({ ...result, source: "gemini-multimodal" });
  } catch (error) {
    console.error("[coach] exercise identification failed", error);
    return res.status(502).json({ error: "Exercise identification is temporarily unavailable." });
  }
});
