import { Router } from "express";
import { db } from "../../db/client";
import { requireAuth, AuthedRequest } from "../../common/auth";
import { primaryMuscleMatchesTarget } from "../workouts/muscleTaxonomy";
import { findExerciseDemo, exerciseDemoEmbedUrl } from "./exerciseMedia";
import { answerExerciseQuestion } from "./exerciseAssistant";
import { z } from "zod";

export const exerciseRouter = Router();

async function equipmentNamesFor(exerciseId: string): Promise<string[]> {
  const rows = await db.all<{ name: string }>(
    `SELECT eq.name FROM ExerciseEquipment ee JOIN Equipment eq ON eq.id = ee.equipmentId WHERE ee.exerciseId = ?`,
    exerciseId
  );
  return rows.map((r) => r.name);
}

async function useNormalizedPrimaryMuscles<T extends { id: string; primaryMuscle: string }>(exercises: T[]): Promise<T[]> {
  if (exercises.length === 0) return exercises;
  const rows = await db.all<{ exerciseId: string; name: string }>(
    `SELECT em.exerciseId,m.name FROM ExerciseMuscle em JOIN Muscle m ON m.id=em.muscleId WHERE em.role='PRIMARY' AND em.exerciseId IN (${exercises.map(() => "?").join(",")})`,
    ...exercises.map((exercise) => exercise.id),
  );
  const primaryById = new Map(rows.map((row) => [row.exerciseId, row.name]));
  return exercises.map((exercise) => ({ ...exercise, primaryMuscle: primaryById.get(exercise.id) || exercise.primaryMuscle }));
}

exerciseRouter.get("/", async (req, res) => {
  const { muscle } = req.query;
  const allExercises = await db.all<any>(`SELECT * FROM Exercise`);
  const normalizedExercises = await useNormalizedPrimaryMuscles(allExercises);
  const exercises = muscle
    ? normalizedExercises.filter((exercise) => primaryMuscleMatchesTarget(String(muscle), exercise.primaryMuscle))
    : normalizedExercises;

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
  const rows = await db.all<any>(
    `SELECT e.* FROM Exercise e
     JOIN ExerciseEquipment ee ON ee.exerciseId = e.id
     WHERE ee.equipmentId = ?`,
    equipmentId
  );
  const exercises = await useNormalizedPrimaryMuscles(rows);

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

  const rows = await db.all<any>(
    `SELECT e.* FROM Exercise e
     JOIN ExerciseMuscle em ON em.exerciseId = e.id
     WHERE em.muscleId = ?`,
    muscleId
  );
  const exercises = await useNormalizedPrimaryMuscles(rows);

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
  const record = await db.get<any>(`SELECT * FROM Exercise WHERE id = ?`, req.params.id);
  if (!record) return res.status(404).json({ error: "Exercise not found" });
  const [e] = await useNormalizedPrimaryMuscles([record]);
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

exerciseRouter.get("/:id/demo-video", async (req, res) => {
  const exercise = await db.get<{ id: string; name: string; instructions: string; primaryMuscle: string; movementPattern: string }>(
    `SELECT id,name,instructions,primaryMuscle,movementPattern FROM Exercise WHERE id = ?`, req.params.id
  );
  if (!exercise) return res.status(404).json({ code: "EXERCISE_NOT_FOUND", error: "Exercise not found in the catalog." });
  const equipment = await equipmentNamesFor(exercise.id);
  const demo = findExerciseDemo(exercise.name, equipment, exercise);
  return res.json({ exerciseId: exercise.id, demoVideo: demo ? { ...demo, embedUrl: exerciseDemoEmbedUrl(demo) } : null });
});

const exerciseQuestionSchema = z.object({ question: z.string().trim().min(1).max(500) });
exerciseRouter.post("/:id/ask", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = exerciseQuestionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter a question about this exercise (up to 500 characters)." });
  const exercise = await db.get<{
    id: string; name: string; primaryMuscle: string; secondaryMuscles: string; instructions: string; movementPattern: string;
  }>(`SELECT id,name,primaryMuscle,secondaryMuscles,instructions,movementPattern FROM Exercise WHERE id = ?`, req.params.id);
  if (!exercise) return res.status(404).json({ code: "EXERCISE_NOT_FOUND", error: "Exercise not found in the catalog." });
  const primary = await db.get<{ name: string }>(
    `SELECT m.name FROM ExerciseMuscle em JOIN Muscle m ON m.id=em.muscleId WHERE em.exerciseId = ? AND em.role='PRIMARY' LIMIT 1`, exercise.id);
  const secondary = await db.all<{ name: string }>(
    `SELECT m.name FROM ExerciseMuscle em JOIN Muscle m ON m.id=em.muscleId WHERE em.exerciseId = ? AND em.role='SECONDARY' ORDER BY m.name`, exercise.id);
  const equipment = await equipmentNamesFor(exercise.id);
  const alternativeRows = await db.all<{ id: string; name: string }>(
    `SELECT e.id,e.name FROM ExerciseSubstitution s JOIN Exercise e ON e.id=s.substituteId WHERE s.baseExerciseId=? ORDER BY s.priority ASC LIMIT 8`,
    exercise.id,
  );
  const alternatives = await Promise.all(alternativeRows.map(async (alternative) => ({
    name: alternative.name,
    equipment: await equipmentNamesFor(alternative.id),
  })));
  const answer = await answerExerciseQuestion({
    name: exercise.name,
    primaryMuscle: primary?.name || exercise.primaryMuscle,
    secondaryMuscles: secondary.length ? secondary.map((muscle) => muscle.name) : (exercise.secondaryMuscles || "").split(",").filter(Boolean),
    equipment,
    instructions: exercise.instructions || "",
    movementPattern: exercise.movementPattern,
    alternatives,
  }, parsed.data.question);
  return res.json({ exerciseId: exercise.id, answer });
});
