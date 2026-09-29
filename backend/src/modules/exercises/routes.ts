import { Router } from "express";
import { db } from "../../db/client";

export const exerciseRouter = Router();

async function equipmentNamesFor(exerciseId: string): Promise<string[]> {
  const rows = await db.all<{ name: string }>(
    `SELECT eq.name FROM ExerciseEquipment ee JOIN Equipment eq ON eq.id = ee.equipmentId WHERE ee.exerciseId = ?`,
    exerciseId
  );
  return rows.map((r) => r.name);
}

exerciseRouter.get("/", async (req, res) => {
  const { muscle } = req.query;
  const exercises = muscle
    ? await db.all<any>(`SELECT * FROM Exercise WHERE primaryMuscle = ?`, String(muscle))
    : await db.all<any>(`SELECT * FROM Exercise`);

  const results: Array<{
    id: string;
    name: string;
    primaryMuscle: string;
    secondaryMuscles: string[];
    movementPattern: string;
    difficulty: string;
    equipmentRequired: string[];
    requiresEquipment: boolean;
  }> = [];

  for (const e of exercises) {
    const equipmentRequired = await equipmentNamesFor(e.id);
    results.push({
      id: e.id,
      name: e.name,
      primaryMuscle: e.primaryMuscle,
      secondaryMuscles: (e.secondaryMuscles || "").split(",").filter(Boolean),
      movementPattern: e.movementPattern,
      difficulty: e.difficulty,
      equipmentRequired,
      requiresEquipment: equipmentRequired.length > 0,
    });
  }
  return res.json(results);
});

exerciseRouter.get("/by-equipment/:equipmentId", async (req, res) => {
  const { equipmentId } = req.params;
  const exercises = await db.all<any>(
    `SELECT e.* FROM Exercise e
     JOIN ExerciseEquipment ee ON ee.exerciseId = e.id
     WHERE ee.equipmentId = ?`,
    equipmentId
  );

  const results: Array<{
    id: string;
    name: string;
    primaryMuscle: string;
    secondaryMuscles: string[];
    movementPattern: string;
    difficulty: string;
    equipmentRequired: string[];
    requiresEquipment: boolean;
  }> = [];

  for (const e of exercises) {
    const equipmentRequired = await equipmentNamesFor(e.id);
    results.push({
      id: e.id,
      name: e.name,
      primaryMuscle: e.primaryMuscle,
      secondaryMuscles: (e.secondaryMuscles || "").split(",").filter(Boolean),
      movementPattern: e.movementPattern,
      difficulty: e.difficulty,
      equipmentRequired,
      requiresEquipment: equipmentRequired.length > 0,
    });
  }
  return res.json(results);
});

exerciseRouter.get("/by-muscle/:muscleId", async (req, res) => {
  const { muscleId } = req.params;
  const muscle = await db.get<{ name: string }>(`SELECT name FROM Muscle WHERE id = ?`, muscleId);
  if (!muscle) return res.status(404).json({ error: "Muscle not found" });

  const exercises = await db.all<any>(
    `SELECT e.* FROM Exercise e
     JOIN ExerciseMuscle em ON em.exerciseId = e.id
     WHERE em.muscleId = ?`,
    muscleId
  );

  const results: Array<{
    id: string;
    name: string;
    primaryMuscle: string;
    secondaryMuscles: string[];
    movementPattern: string;
    difficulty: string;
    equipmentRequired: string[];
    requiresEquipment: boolean;
    role: string | undefined;
  }> = [];

  for (const e of exercises) {
    const em = await db.get<{ role: string }>(
      `SELECT role FROM ExerciseMuscle WHERE exerciseId = ? AND muscleId = ?`,
      e.id, muscleId
    );
    const equipmentRequired = await equipmentNamesFor(e.id);
    results.push({
      id: e.id,
      name: e.name,
      primaryMuscle: e.primaryMuscle,
      secondaryMuscles: (e.secondaryMuscles || "").split(",").filter(Boolean),
      movementPattern: e.movementPattern,
      difficulty: e.difficulty,
      equipmentRequired,
      requiresEquipment: equipmentRequired.length > 0,
      role: em?.role,
    });
  }
  return res.json({ muscle: muscle.name, exercises: results });
});

exerciseRouter.get("/:id", async (req, res) => {
  const e = await db.get<any>(`SELECT * FROM Exercise WHERE id = ?`, req.params.id);
  if (!e) return res.status(404).json({ error: "Exercise not found" });
  const equipmentRequired = await equipmentNamesFor(e.id);
  return res.json({
    id: e.id,
    name: e.name,
    primaryMuscle: e.primaryMuscle,
    secondaryMuscles: (e.secondaryMuscles || "").split(",").filter(Boolean),
    movementPattern: e.movementPattern,
    difficulty: e.difficulty,
    instructions: e.instructions,
    defaultSets: e.defaultSets,
    repRangeLow: e.repRangeLow,
    repRangeHigh: e.repRangeHigh,
    equipmentRequired,
    requiresEquipment: equipmentRequired.length > 0,
  });
});

exerciseRouter.get("/:id/substitutions", async (req, res) => {
  const edges = await db.all<{ substituteId: string; priority: number }>(
    `SELECT * FROM ExerciseSubstitution WHERE baseExerciseId = ? ORDER BY priority ASC`,
    req.params.id
  );

  const results: Array<{
    exerciseId: string;
    name: string;
    priority: number;
    equipmentRequired: string[];
    requiresEquipment: boolean;
  }> = [];

  for (const edge of edges) {
    const sub = await db.get<any>(`SELECT * FROM Exercise WHERE id = ?`, edge.substituteId);
    if (!sub) continue;
    const equipmentRequired = await equipmentNamesFor(sub.id);
    results.push({
      exerciseId: sub.id,
      name: sub.name,
      priority: edge.priority,
      equipmentRequired,
      requiresEquipment: equipmentRequired.length > 0,
    });
  }
  return res.json(results);
});
