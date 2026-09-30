import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { db } from "../../db/client";
import { requireAuth, AuthedRequest } from "../../common/auth";
import { getEquipmentVisionProvider } from "../../vision/equipmentVisionProvider";

export const equipmentRouter = Router();

// Public: list all known equipment (used to render onboarding checkboxes)
equipmentRouter.get("/", async (_req, res) => {
  const equipment = await db.all(`SELECT * FROM Equipment ORDER BY name ASC`);
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
  return res.json(result);
});

equipmentRouter.get("/user/equipment", requireAuth, async (req: AuthedRequest, res) => {
  const result = await db.all(
    `SELECT e.* FROM Equipment e JOIN UserEquipment ue ON ue.equipmentId = e.id WHERE ue.userId = ?`,
    req.userId!
  );
  return res.json(result);
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
equipmentRouter.post("/detect", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = detectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "imageBase64 (raw base64, no data: prefix) is required" });

  const provider = getEquipmentVisionProvider();
  const started = Date.now();
  let result;
  try {
    result = await provider.detectEquipment(parsed.data.imageBase64);
  } catch (e: any) {
    console.error(JSON.stringify({ event: "equipment_detection_error", provider: provider.getProviderName(), latencyMs: Date.now() - started, error: e?.message || String(e) }));
    return res.status(503).json({ error: "EQUIPMENT_DETECTION_FAILED", message: "Equipment detection is temporarily unavailable." });
  }

  if (!result.configured) {
    return res.json({
      configured: false,
      message:
        "No equipment-vision model is connected, so nothing was auto-detected. Set EQUIPMENT_VISION_API_KEY to enable camera-based detection.",
      detections: [],
      suggestedExercises: [],
    });
  }

  if (result.detections.length === 0) {
    return res.json({
      configured: true,
      message: "No known equipment was recognized in that photo — try a clearer angle or better lighting.",
      detections: [],
      suggestedExercises: [],
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
    detections: result.detections,
    suggestedExercises: suggested.slice(0, 6),
  });
});
