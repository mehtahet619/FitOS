import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../common/auth";
import { ComparisonError, getComparisonProvider } from "./comparisonProvider";
import { matchSupportedExercise } from "./exerciseMapping";
import { normalizeComparison } from "./comparisonResult";

export const comparisonRouter = Router();
comparisonRouter.use(requireAuth);

/**
 * User-facing copy. Kept server-side so the frontend and the API agree, and so
 * the wording cannot drift between the two.
 */
const UNAVAILABLE_MESSAGE =
  "Exercise form analysis is temporarily unavailable. We're working to restore it. You can continue using the other FitOS features.";
const NO_RESULT_MESSAGE = "We couldn't analyze this movement right now. Please try again in a moment.";
const INVALID_REQUEST_MESSAGE = "That movement data couldn't be analyzed. Capture one full repetition and try again.";

// Pose sequences are large but bounded. Frame/value caps keep a single request
// well under the router's body limit and stop one client from pinning memory.
const MAX_FRAMES = 300;
const MAX_VALUES_PER_FRAME = 200;
export const COMPARISON_BODY_LIMIT = "512kb";

const sequenceSchema = z
  .array(z.array(z.number().finite()).min(1).max(MAX_VALUES_PER_FRAME))
  .min(2)
  .max(MAX_FRAMES);

const analyzeSchema = z.object({
  exerciseKey: z.string().trim().min(1).max(64),
  exerciseName: z.string().trim().max(120).optional(),
  sequence: sequenceSchema,
  referenceSequence: sequenceSchema,
});

// Comparison analysis is user-triggered and comparatively expensive, so it gets
// a tighter budget than the global limiter.
const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: "COMPARISON_RATE_LIMITED", error: "Too many form analyses. Please wait a moment and try again." },
});

/**
 * Maps a provider failure onto a predictable HTTP response. Only the failure
 * kind and upstream status are logged — never the API key, request headers, or
 * pose data.
 */
function respondWithFailure(res: import("express").Response, error: unknown, stage: string) {
  if (error instanceof ComparisonError) {
    console.warn(`[comparison] stage=${stage} kind=${error.kind} upstreamStatus=${error.status ?? "none"}`);
    if (error.kind === "timeout") {
      return res.status(504).json({ code: "COMPARISON_TIMEOUT", error: "Exercise form analysis took too long. Please try again." });
    }
    if (error.kind === "invalid_response") {
      return res.status(502).json({ code: "COMPARISON_INVALID_RESPONSE", error: NO_RESULT_MESSAGE });
    }
    // "unauthorized" is deliberately reported as unavailable: the user must not
    // be told anything about the service's credentials.
    return res.status(503).json({ code: "COMPARISON_UNAVAILABLE", error: UNAVAILABLE_MESSAGE });
  }
  console.warn(`[comparison] stage=${stage} kind=unexpected`);
  return res.status(503).json({ code: "COMPARISON_UNAVAILABLE", error: UNAVAILABLE_MESSAGE });
}

/**
 * Whether the comparison feature should be offered at all. Always answers 200 so
 * a missing configuration or a down service can never surface as a transport
 * error, log the user out, or block the Vision Coach from loading.
 */
comparisonRouter.get("/status", async (_req, res) => {
  const provider = getComparisonProvider();
  if (!provider) return res.json({ configured: false, available: false, supportedExercises: [] });
  try {
    const catalogue = await provider.listExercises();
    return res.json({
      configured: true,
      available: true,
      supportedExercises: catalogue.map((exercise) => exercise.name),
    });
  } catch (error) {
    if (error instanceof ComparisonError) {
      console.warn(`[comparison] stage=status kind=${error.kind} upstreamStatus=${error.status ?? "none"}`);
    } else {
      console.warn("[comparison] stage=status kind=unexpected");
    }
    return res.json({ configured: true, available: false, supportedExercises: [] });
  }
});

comparisonRouter.post("/analyze", analyzeLimiter, async (req: AuthedRequest, res) => {
  const parsed = analyzeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ code: "COMPARISON_INVALID_REQUEST", error: INVALID_REQUEST_MESSAGE });
  }

  const provider = getComparisonProvider();
  if (!provider) {
    return res.status(503).json({ code: "COMPARISON_NOT_CONFIGURED", error: UNAVAILABLE_MESSAGE });
  }

  const { exerciseKey, sequence, referenceSequence } = parsed.data;
  const requestedName = parsed.data.exerciseName ?? exerciseKey;

  let catalogue;
  try {
    catalogue = await provider.listExercises();
  } catch (error) {
    return respondWithFailure(res, error, "list-exercises");
  }

  const match = matchSupportedExercise(exerciseKey, catalogue);
  if (!match.matched || !match.exerciseId) {
    return res.status(422).json({
      code: "COMPARISON_EXERCISE_UNSUPPORTED",
      error: `${requestedName} isn't supported for form comparison yet.`,
      supportedExercises: catalogue.map((exercise) => exercise.name),
    });
  }

  let raw: unknown;
  try {
    raw = await provider.compare({
      exercise_id: match.exerciseId,
      reference_sequence: referenceSequence,
      user_sequence: sequence,
    });
  } catch (error) {
    return respondWithFailure(res, error, "compare");
  }

  const analysis = normalizeComparison(raw, {
    exerciseId: match.exerciseId,
    exerciseName: match.exerciseName ?? requestedName,
  });
  if (!analysis) {
    // The service answered but returned nothing the coach can honestly display.
    console.warn(`[comparison] stage=compare kind=no-usable-result exercise=${match.exerciseId}`);
    return res.status(502).json({ code: "COMPARISON_NO_RESULT", error: NO_RESULT_MESSAGE });
  }

  return res.json({ available: true, analysis });
});
