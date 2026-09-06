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

  const result = await Promise.all(exercises.map(async (e) => ({
      id: e.id,
      name: e.name,
      primaryMuscle: e.primaryMuscle,
      secondaryMuscles: (e.secondaryMuscles || "").split(",").filter(Boolean),
      movementPattern: e.movementPattern,
      difficulty: e.difficulty,
      equipmentRequired: await equipmentNamesFor(e.id),
  })));
  return res.json(result);
});

exerciseRouter.get("/:id", async (req, res) => {
  const e = await db.get<any>(`SELECT * FROM Exercise WHERE id = ?`, req.params.id);
  if (!e) return res.status(404).json({ error: "Exercise not found" });
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
    equipmentRequired: await equipmentNamesFor(e.id),
  });
});

exerciseRouter.get("/:id/substitutions", async (req, res) => {
  const edges = await db.all<{ substituteId: string; priority: number }>(
    `SELECT * FROM ExerciseSubstitution WHERE baseExerciseId = ? ORDER BY priority ASC`,
    req.params.id
  );

  const result = await Promise.all(edges.map(async (edge) => {
      const sub = await db.get<any>(`SELECT * FROM Exercise WHERE id = ?`, edge.substituteId);
      return {
        exerciseId: sub.id,
        name: sub.name,
        priority: edge.priority,
        equipmentRequired: await equipmentNamesFor(sub.id),
      };
    }));
  return res.json(result);
});
