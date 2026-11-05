import { z } from "zod";

/** Structural contracts only. Feature modules must still apply domain rules. */
export const AiExerciseCandidateSchema = z.object({
  exercise: z.string().trim().min(1).max(100),
  machine: z.string().trim().min(1).max(80),
  muscle: z.string().trim().min(1).max(40),
  secondaryMuscles: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  instructions: z.string().max(1200).optional(),
  sets: z.number().int().min(1).max(6).optional(),
  repRangeLow: z.number().int().min(1).max(30).optional(),
  repRangeHigh: z.number().int().min(1).max(30).optional(),
}).passthrough();

export const AiExerciseGenerationSchema = z.object({
  exercises: z.array(z.unknown()).min(1).max(30),
}).passthrough();

export const HealthyDishRankingSchema = z.object({
  recommendations: z.array(z.object({
    dishId: z.string().min(1),
    healthScore: z.number().finite(),
    reasons: z.array(z.string().max(180)).max(4).optional(),
  }).passthrough()).min(1),
}).passthrough();
