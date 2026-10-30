import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { db, nowIso } from "../../db/client";
import { requireAuth, AuthedRequest } from "../../common/auth";
import { getEquipmentVisionProvider } from "../../vision/equipmentVisionProvider";
import { ensureCanonicalEquipmentCatalog } from "./catalog";
import { recordEquipmentFeedback, recordEquipmentInference } from "../../vision/equipmentMetrics";
import { runPeopleCountingWorkflow } from "../../vision/peopleCountingWorkflowProvider";

export const equipmentRouter = Router();

// Public: list all known equipment (used to render onboarding checkboxes)
equipmentRouter.get("/", async (_req, res) => {
  const equipment = await ensureCanonicalEquipmentCatalog(db);
  return res.json(equipment);
});

const setEquipmentSchema = z.object({
  equipmentNames: z.array(z.string().min(1)),
});

// Replaces the user's full equipment set. Unknown names are created as
// custom equipment on the fly (per "enter custom equipment" requirement) —
// they simply won't be linked to any Exercise until an admin/seed process
// maps them, so they never silently unlock exercises they shouldn't.
equipmentRouter.post("/user/equipment", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = setEquipmentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const userId = req.userId!;

  const equipmentIds: string[] = [];
  for (const rawName of parsed.data.equipmentNames) {
    const name = rawName.trim();
    if (!name) continue;
    let eq = await db.get<{ id: string }>(`SELECT * FROM Equipment WHERE name = ?`, name);
    if (!eq) {
      const id = uuidv4();
      await db.run(`INSERT INTO Equipment (id, name, isCustom) VALUES (?, ?, 1)`, id, name);
      eq = { id };
    }
    equipmentIds.push(eq.id);
  }

  await db.run(`DELETE FROM UserEquipment WHERE userId = ?`, userId);
  for (const equipmentId of equipmentIds) {
    await db.run(
      `INSERT INTO UserEquipment (id, userId, equipmentId) VALUES (?, ?, ?) ON CONFLICT(userId, equipmentId) DO NOTHING`,
      uuidv4(),
      userId,
      equipmentId
    );
  }

  const result = await db.all(
    `SELECT e.* FROM Equipment e JOIN UserEquipment ue ON ue.equipmentId = e.id WHERE ue.userId = ?`,
    userId
  );
  const timestamp = nowIso();
  const currentProfile = await db.get<{ id: string; createdAt: string; lastScanAt: string | null }>(
    `SELECT id, createdAt, lastScanAt FROM GymEquipmentProfile WHERE userId = ?`, userId
  );
  await db.run(
    `INSERT INTO GymEquipmentProfile (id, userId, equipmentJson, tourCompleted, lastScanAt, lastConfirmedDate, createdAt, updatedAt)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(userId) DO UPDATE SET equipmentJson=excluded.equipmentJson, tourCompleted=1, updatedAt=excluded.updatedAt`,
    currentProfile?.id ?? uuidv4(), userId, JSON.stringify(result.map((item: any) => item.name)),
    currentProfile?.lastScanAt ?? null, null, currentProfile?.createdAt ?? timestamp, timestamp
  );
  return res.json(result);
});

equipmentRouter.get("/user/equipment", requireAuth, async (req: AuthedRequest, res) => {
  const result = await db.all(
    `SELECT e.* FROM Equipment e JOIN UserEquipment ue ON ue.equipmentId = e.id WHERE ue.userId = ?`,
    req.userId!
  );
  return res.json(result);
});

equipmentRouter.get("/gym-profile", requireAuth, async (req: AuthedRequest, res) => {
  const profile = await db.get<any>(`SELECT * FROM GymEquipmentProfile WHERE userId = ?`, req.userId!);
  if (!profile) return res.json({ gymTourCompleted: false, profileId: null, equipment: [], lastScanAt: null, lastConfirmedDate: null });
  let equipment: unknown[] = [];
  try { equipment = JSON.parse(profile.equipmentJson || "[]"); } catch { equipment = []; }
  return res.json({ gymTourCompleted: Boolean(profile.tourCompleted), profileId: profile.id, equipment, lastScanAt: profile.lastScanAt, lastConfirmedDate: profile.lastConfirmedDate ?? null });
});

const sameGymConfirmationSchema = z.object({ confirmedDate: z.unknown().optional() });
equipmentRouter.post("/gym-profile/confirm-same", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = sameGymConfirmationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid gym confirmation." });
  const suppliedDate = typeof parsed.data.confirmedDate === "string" ? parsed.data.confirmedDate.trim() : "";
  const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(suppliedDate) ? suppliedDate : "";
  const parsedDate = suppliedDate ? new Date(suppliedDate) : null;
  const confirmedDate = isoDate || (parsedDate && Number.isFinite(parsedDate.getTime())
    ? [parsedDate.getFullYear(), String(parsedDate.getMonth() + 1).padStart(2, "0"), String(parsedDate.getDate()).padStart(2, "0")].join("-")
    : nowIso().slice(0, 10));
  const profile = await db.get<{ id: string }>(`SELECT id FROM GymEquipmentProfile WHERE userId = ? AND tourCompleted = 1`, req.userId!);
  if (!profile) return res.status(404).json({ error: "No completed gym profile exists." });
  await db.run(`UPDATE GymEquipmentProfile SET lastConfirmedDate = ?, updatedAt = ? WHERE userId = ?`, confirmedDate, nowIso(), req.userId!);
  return res.json({ confirmed: true, lastConfirmedDate: confirmedDate });
});

const gymTourSchema = z.object({
  completed: z.boolean(),
  detections: z.array(z.object({
    equipmentName: z.string().min(1),
    confidence: z.number().min(0).max(1),
    evidenceFrames: z.number().int().min(1),
  })).max(200),
});

equipmentRouter.post("/gym-tour", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = gymTourSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid gym tour input" });
  const reliable = parsed.data.detections
    .filter((d) => d.confidence >= 0 && d.evidenceFrames >= 2)
    .reduce((map, detection) => {
      const current = map.get(detection.equipmentName);
      if (!current || detection.confidence > current.confidence) map.set(detection.equipmentName, detection);
      return map;
    }, new Map<string, { equipmentName: string; confidence: number; evidenceFrames: number }>());
  const names = [...reliable.keys()];
  const userId = req.userId!;
  const ts = nowIso();
  const existing = await db.get<{ id: string }>(`SELECT id FROM GymEquipmentProfile WHERE userId = ?`, userId);
  const profileId = existing?.id ?? uuidv4();

  if (parsed.data.completed) {
    await db.run(
      `INSERT INTO GymEquipmentProfile (id, userId, equipmentJson, tourCompleted, lastScanAt, lastConfirmedDate, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, ?, NULL, ?, ?)
       ON CONFLICT(userId) DO UPDATE SET equipmentJson=excluded.equipmentJson, tourCompleted=1, lastScanAt=excluded.lastScanAt, lastConfirmedDate=NULL, updatedAt=excluded.updatedAt`,
      profileId, userId, JSON.stringify(names), ts, ts, ts
    );
    await db.run(`DELETE FROM UserEquipment WHERE userId = ?`, userId);
    for (const name of names) {
      let equipment = await db.get<{ id: string }>(`SELECT id FROM Equipment WHERE name = ?`, name);
      if (!equipment) {
        const equipmentId = uuidv4();
        await db.run(`INSERT INTO Equipment (id, name, isCustom) VALUES (?, ?, 1)`, equipmentId, name);
        equipment = { id: equipmentId };
      }
      await db.run(
        `INSERT INTO UserEquipment (id, userId, equipmentId) VALUES (?, ?, ?) ON CONFLICT(userId, equipmentId) DO NOTHING`,
        uuidv4(), userId, equipment.id
      );
    }
    console.info(`[CV] Gym profile updated: ${JSON.stringify(names)}`);
  }

  return res.json({ profileId, gymTourCompleted: parsed.data.completed, equipment: names, lastScanAt: parsed.data.completed ? ts : null });
});

const confirmSchema = z.object({
  detections: z.array(z.object({
    equipmentName: z.string().min(1),
    confidence: z.number().min(0).max(1),
    rawLabel: z.string().optional(),
    boundingBox: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    }).optional(),
  })),
  sessionId: z.string().optional(),
});

// Confirm equipment detections from AI scan - stores confirmed detections
equipmentRouter.post("/confirm", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });

  const userId = req.userId!;
  const { detections, sessionId } = parsed.data;

  const results = [];
  for (const detection of detections) {
    const eq = await db.get<{ id: string }>(`SELECT id FROM Equipment WHERE name = ?`, detection.equipmentName);
    if (!eq) continue;

    const id = uuidv4();
    const ts = new Date().toISOString();
    await db.run(
      `INSERT INTO EquipmentDetection (id, userId, sessionId, equipmentId, confidence, source, confirmed, createdAt)
       VALUES (?, ?, ?, ?, ?, 'roboflow', 1, ?)`,
      id, userId, sessionId || null, eq.id, detection.confidence, ts
    );

    // Also add to user's equipment if not already there
    await db.run(
      `INSERT INTO UserEquipment (id, userId, equipmentId) VALUES (?, ?, ?) ON CONFLICT(userId, equipmentId) DO NOTHING`,
      uuidv4(), userId, eq.id
    );

    results.push({ ...detection, equipmentId: eq.id, confirmed: true });
  }

  return res.json({ confirmed: results });
});

const equipmentFeedbackSchema = z.object({
  predictedLabel: z.string().trim().min(1).max(120),
  correctedLabel: z.string().trim().min(1).max(120).optional(),
  verdict: z.enum(["CONFIRMED", "REJECTED"]),
  confidence: z.number().min(0).max(1),
  imageBase64: z.string().min(100).max(2_000_000),
}).superRefine((value, context) => {
  if (value.verdict === "REJECTED" && !value.correctedLabel) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Corrected equipment name is required for rejected detections." });
  }
});

equipmentRouter.post("/feedback", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = equipmentFeedbackSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid equipment feedback", details: parsed.error.flatten() });
  const feedback = parsed.data;
  const id = uuidv4();
  await db.run(
    `INSERT INTO GymEquipmentFeedback (id, userId, predictedLabel, correctedLabel, verdict, confidence, imageBase64, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id, req.userId!, feedback.predictedLabel, feedback.correctedLabel ?? null,
    feedback.verdict, feedback.confidence, feedback.imageBase64, nowIso()
  );
  recordEquipmentFeedback(feedback.verdict);
  if (feedback.verdict === "CONFIRMED") {
    let equipment = await db.get<{ id: string }>(`SELECT id FROM Equipment WHERE name = ?`, feedback.predictedLabel);
    if (!equipment) {
      const equipmentId = uuidv4();
      await db.run(`INSERT INTO Equipment (id, name, isCustom) VALUES (?, ?, 1)`, equipmentId, feedback.predictedLabel);
      equipment = { id: equipmentId };
    }
    await db.run(
      `INSERT INTO UserEquipment (id, userId, equipmentId) VALUES (?, ?, ?) ON CONFLICT(userId, equipmentId) DO NOTHING`,
      uuidv4(), req.userId!, equipment.id
    );
    const currentProfile = await db.get<{ id: string; equipmentJson: string; tourCompleted: number; lastScanAt: string | null; createdAt: string }>(
      `SELECT id, equipmentJson, tourCompleted, lastScanAt, createdAt FROM GymEquipmentProfile WHERE userId = ?`, req.userId!
    );
    let currentNames: string[] = [];
    try { currentNames = JSON.parse(currentProfile?.equipmentJson || "[]"); } catch { currentNames = []; }
    if (!currentNames.includes(feedback.predictedLabel)) currentNames.push(feedback.predictedLabel);
    const timestamp = nowIso();
    const profileId = currentProfile?.id ?? uuidv4();
    await db.run(
      `INSERT INTO GymEquipmentProfile (id, userId, equipmentJson, tourCompleted, lastScanAt, lastConfirmedDate, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(userId) DO UPDATE SET equipmentJson=excluded.equipmentJson, updatedAt=excluded.updatedAt`,
      profileId, req.userId!, JSON.stringify(currentNames), currentProfile?.tourCompleted ?? 0,
      currentProfile?.lastScanAt ?? null, currentProfile?.createdAt ?? timestamp, timestamp
    );
  }
  return res.status(201).json({ saved: true, feedbackId: id, verdict: feedback.verdict });
});

const detectSchema = z.object({
  imageBase64: z.string().min(100), // raw base64, no "data:image/..." prefix
});

// Point the camera at your gym corner, snap a photo -> detect which known
// Equipment rows are actually visible -> suggest exercises + how-to-perform
// instructions for exactly that equipment. Detection itself is a pluggable
// vision model (see src/vision/equipmentVisionProvider.ts); exercise
// selection and instructions are the same deterministic Exercise table the
// rest of the app uses — the vision model only ever supplies equipment
// labels, never exercise advice.
equipmentRouter.post("/crowd-analysis", requireAuth, async (req: AuthedRequest, res) => {
  const imageBase64 = typeof req.body?.imageBase64 === "string" ? req.body.imageBase64 : "";
  if (imageBase64.length < 100) {
    return res.status(400).json({ error: "A valid camera frame is required for crowd analysis." });
  }
  if (imageBase64.length > 5_000_000) {
    return res.status(413).json({ error: "Camera frame is too large for crowd analysis." });
  }
  const output = await runPeopleCountingWorkflow(
    { type: "base64", value: imageBase64 },
    { timeoutMs: 10_000, maxRetries: 0 }
  );
  const candidates = findPeoplePredictions(output);
  const people = candidates.map((item) => {
    const box = item.bounding_box && typeof item.bounding_box === "object"
      ? item.bounding_box as Record<string, unknown>
      : item;
    const x = Number(box.x);
    const y = Number(box.y);
    const width = Number(box.width);
    const height = Number(box.height);
    const confidence = Number(item.confidence ?? item.score ?? 0);
    return {
      label: String(item.class ?? item.name ?? item.label ?? "person"),
      confidence: Number.isFinite(confidence) ? confidence : 0,
      boundingBox: [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
        ? { x, y, width, height }
        : undefined,
    };
  }).filter((person) => /person|people|human/i.test(person.label));
  const explicitCount = Number(output.count ?? output.people_count ?? output.person_count);
  const peopleCount = Number.isFinite(explicitCount) && explicitCount >= 0
    ? Math.round(explicitCount)
    : people.length;
  return res.json({
    configured: true,
    provider: "roboflow-people-counting",
    peopleCount,
    detections: people,
    crowdLevel: peopleCount === 0 ? "Clear" : peopleCount <= 3 ? "Low" : peopleCount <= 8 ? "Moderate" : "Busy",
    occupancy: "People count only. Individual machine occupancy is not confirmed by this workflow.",
  });
});

function findPeoplePredictions(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 5 || !value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    if (value.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry))) {
      const rows = value as Record<string, unknown>[];
      if (rows.some((row) => "class" in row || "label" in row || "confidence" in row)) return rows;
    }
    return value.flatMap((entry) => findPeoplePredictions(entry, depth + 1));
  }
  const record = value as Record<string, unknown>;
  for (const key of ["predictions", "detections", "people", "persons"]) {
    if (key in record) {
      const found = findPeoplePredictions(record[key], depth + 1);
      if (found.length) return found;
    }
  }
  for (const child of Object.values(record)) {
    const found = findPeoplePredictions(child, depth + 1);
    if (found.length) return found;
  }
  return [];
}

equipmentRouter.post("/detect", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = detectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "imageBase64 (raw base64, no data: prefix) is required" });

  const provider = getEquipmentVisionProvider();
  const started = Date.now();
  let result;
  try {
    result = await provider.detectEquipment(parsed.data.imageBase64);
  } catch (e: any) {
    recordEquipmentInference({ outcome: "error", latencyMs: Date.now() - started });
    console.error(JSON.stringify({ event: "equipment_detection_error", provider: provider.getProviderName(), latencyMs: Date.now() - started, error: e?.message || String(e) }));
    return res.status(503).json({ error: "EQUIPMENT_DETECTION_FAILED", message: "Equipment detection is temporarily unavailable." });
  }

  recordEquipmentInference({ outcome: "success", latencyMs: result.latencyMs ?? Date.now() - started, rawPredictions: result.rawDetectionCount ?? result.detections.length, acceptedPredictions: result.detections.length });

  if (!result.configured) {
    return res.json({
      configured: false,
      error: "MODEL_NOT_CONFIGURED",
      message: result.error,
      provider: result.provider,
      detections: [],
      equipment: [],
      suggestedExercises: [],
      latencyMs: result.latencyMs,
      promptLabels: result.promptLabels,
    });
  }

  if (result.detections.length === 0) {
    return res.json({
      configured: true,
      message: "No known equipment was recognized in that photo — try a clearer angle or better lighting.",
      provider: result.provider,
      detections: [],
      equipment: [],
      suggestedExercises: [],
      latencyMs: result.latencyMs,
      rawDetectionCount: result.rawDetectionCount,
      promptLabels: result.promptLabels,
    });
  }

  const detectedNames = result.detections.map((d) => d.equipmentName);

  // Exercises fully performable with exactly the detected equipment set
  // (a subset check: every equipment row the exercise needs must be among
  // what was detected).
  const candidateExercises = await db.all<any>(`SELECT * FROM Exercise`);
  const suggested: any[] = [];
  const seenMuscles = new Set<string>();

  for (const ex of candidateExercises) {
    const required = await db.all<{ name: string }>(
      `SELECT eq.name FROM ExerciseEquipment ee JOIN Equipment eq ON eq.id = ee.equipmentId WHERE ee.exerciseId = ?`,
      ex.id
    );
    const requiredNames = required.map((r) => r.name);
    const performable = requiredNames.every((n) => detectedNames.includes(n));
    if (!performable) continue;
    // One suggestion per muscle group so the result reads like a mini
    // workout, not a dump of every matching row.
    if (seenMuscles.has(ex.primaryMuscle)) continue;
    seenMuscles.add(ex.primaryMuscle);
    suggested.push({
      exerciseId: ex.id,
      name: ex.name,
      primaryMuscle: ex.primaryMuscle,
      difficulty: ex.difficulty,
      sets: ex.defaultSets,
      repRangeLow: ex.repRangeLow,
      repRangeHigh: ex.repRangeHigh,
      howTo: ex.instructions,
      equipmentUsed: requiredNames,
    });
  }

  return res.json({
    configured: true,
    provider: result.provider,
    latencyMs: result.latencyMs,
    rawDetectionCount: result.rawDetectionCount,
    promptLabels: result.promptLabels,
    detections: result.detections,
    equipment: result.detections.map((detection) => ({
      name: detection.equipmentName,
      confidence: detection.confidence,
    })),
    suggestedExercises: suggested.slice(0, 6),
  });
});
