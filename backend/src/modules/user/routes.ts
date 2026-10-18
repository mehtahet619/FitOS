import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { db, nowIso } from "../../db/client";
import { requireAuth, AuthedRequest } from "../../common/auth";
import { computeMacroTargets } from "../nutrition/nutritionEngine";

export const userRouter = Router();
userRouter.use(requireAuth);

const profileSchema = z.object({
  name: z.string().min(1),
  age: z.number().int().positive(),
  gender: z.string(),
  heightCm: z.number().positive(),
  weightKg: z.number().positive(),
  fitnessLevel: z.enum(["beginner", "intermediate", "advanced"]),
  primaryGoal: z.enum(["muscle_gain", "fat_loss", "strength", "general_fitness", "endurance"]),
  daysPerWeek: z.number().int().min(1).max(7),
  // Older onboarding clients may not send a session duration yet.
  sessionMinutes: z.number().int().positive().default(60),
  dietaryPref: z.enum(["vegetarian", "vegan", "non_vegetarian", "eggetarian"]),
  allergies: z.array(z.string()).default([]),
  foodLikes: z.array(z.string()).default([]),
  dailyBudget: z.number().nonnegative(),
});

userRouter.get("/profile", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const started = Date.now();
  const log = (label: string) => {
    console.info(`[TRACE] GET /user/profile:${label} durationMs=${Date.now() - started}`);
  };

  log("profile-query:start");
  const profile = await db.get<any>(`SELECT * FROM UserProfile WHERE userId = ?`, userId);
  const nutritionTargets = await db.get<any>(`SELECT calorieTarget, proteinTargetG, carbTargetG, fatTargetG FROM NutritionProfile WHERE userId = ?`, userId);
  log("profile-query:end");
  if (!profile) return res.status(404).json({ error: "Profile not created yet" });
  log("response ready");
  return res.json({
    ...profile,
    allergies: (profile.allergies || "").split(",").filter(Boolean),
    foodLikes: (profile.foodLikes || "").split(",").filter(Boolean),
  });
});

// This single endpoint doubles as "complete onboarding" for the MVP: saving
// the profile also (re)computes and stores nutrition targets so the
// nutrition module has something to work with immediately.
userRouter.put("/profile", async (req: AuthedRequest, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }
  const data = parsed.data;
  const userId = req.userId!;
  const ts = nowIso();

  const existing = await db.get<{ id: string }>(`SELECT id FROM UserProfile WHERE userId = ?`, userId);

  if (existing) {
    await db.run(
      `UPDATE UserProfile SET name=?, age=?, gender=?, heightCm=?, weightKg=?, fitnessLevel=?, primaryGoal=?, daysPerWeek=?, sessionMinutes=?, dietaryPref=?, allergies=?, foodLikes=?, dailyBudget=?, updatedAt=? WHERE userId=?`
    ,
      data.name,
      data.age,
      data.gender,
      data.heightCm,
      data.weightKg,
      data.fitnessLevel,
      data.primaryGoal,
      data.daysPerWeek,
      data.sessionMinutes,
      data.dietaryPref,
      data.allergies.join(","),
      data.foodLikes.join(","),
      data.dailyBudget,
      ts,
      userId
    );
  } else {
    await db.run(
      `INSERT INTO UserProfile (id, userId, name, age, gender, heightCm, weightKg, fitnessLevel, primaryGoal, daysPerWeek, sessionMinutes, dietaryPref, allergies, foodLikes, dailyBudget, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ,
      uuidv4(),
      userId,
      data.name,
      data.age,
      data.gender,
      data.heightCm,
      data.weightKg,
      data.fitnessLevel,
      data.primaryGoal,
      data.daysPerWeek,
      data.sessionMinutes,
      data.dietaryPref,
      data.allergies.join(","),
      data.foodLikes.join(","),
      data.dailyBudget,
      ts,
      ts
    );
  }

  await db.run(`UPDATE "User" SET name=?, updatedAt=? WHERE id=?`, data.name, ts, userId);

  const targets = computeMacroTargets({
    weightKg: data.weightKg,
    heightCm: data.heightCm,
    age: data.age,
    gender: data.gender,
    daysPerWeek: data.daysPerWeek,
    primaryGoal: data.primaryGoal,
  });

  const existingNutrition = await db.get<{ id: string }>(`SELECT id FROM NutritionProfile WHERE userId = ?`, userId);

  if (existingNutrition) {
    await db.run(
      `UPDATE NutritionProfile SET calorieTarget=?, proteinTargetG=?, carbTargetG=?, fatTargetG=?, updatedAt=? WHERE userId=?`
    , targets.calorieTarget, targets.proteinTargetG, targets.carbTargetG, targets.fatTargetG, ts, userId);
  } else {
    await db.run(
      `INSERT INTO NutritionProfile (id, userId, calorieTarget, proteinTargetG, carbTargetG, fatTargetG, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`
    , uuidv4(), userId, targets.calorieTarget, targets.proteinTargetG, targets.carbTargetG, targets.fatTargetG, ts);
  }

  const profile = await db.get(`SELECT * FROM UserProfile WHERE userId = ?`, userId);
  return res.json({ profile, nutritionTargets: targets });
});
