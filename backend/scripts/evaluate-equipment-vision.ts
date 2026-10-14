import fs from "node:fs/promises";
import path from "node:path";

type Box = { x: number; y: number; width: number; height: number };
type Detection = { equipmentName: string; confidence?: number; rawLabel?: string; boundingBox?: Box };
type EvalCase = {
  id: string;
  category: string;
  image?: string;
  frames?: string[];
  groundTruth: Detection[] | null;
  groundTruthByFrame?: (Detection[] | null)[];
  notes: string;
};
type Manifest = {
  expectedProvider?: string;
  iouThreshold?: number;
  cases: EvalCase[];
  liveScanCases?: unknown[];
};

const baseDirectory = path.resolve(process.cwd(), "vision-eval");
const manifestPath = path.resolve(baseDirectory, process.env.VISION_EVAL_MANIFEST || "manifest.json");
const reportPath = path.resolve(baseDirectory, process.env.VISION_EVAL_REPORT || "latest-report.json");
const apiBaseUrl = process.env.VISION_EVAL_API_BASE?.replace(/\/$/, "");
const bearerToken = process.env.VISION_EVAL_BEARER_TOKEN;
const iouThreshold = 0.5;

function safeRelativePath(filePath: string): string {
  const resolved = path.resolve(baseDirectory, filePath);
  if (resolved !== baseDirectory && !resolved.startsWith(`${baseDirectory}${path.sep}`)) {
    throw new Error(`Image path must stay inside vision-eval/: ${filePath}`);
  }
  return resolved;
}

function iou(a: Box, b: Box): number {
  const aLeft = a.x - a.width / 2;
  const aTop = a.y - a.height / 2;
  const bLeft = b.x - b.width / 2;
  const bTop = b.y - b.height / 2;
  const width = Math.max(0, Math.min(aLeft + a.width, bLeft + b.width) - Math.max(aLeft, bLeft));
  const height = Math.max(0, Math.min(aTop + a.height, bTop + b.height) - Math.max(aTop, bTop));
  const intersection = width * height;
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function matchLabels(predictions: Detection[], truth: Detection[], threshold: number): number {
  const labels = new Set([...predictions, ...truth].map((item) => item.equipmentName));
  let matches = 0;
  for (const label of labels) {
    const predicted = predictions.filter((item) => item.equipmentName === label);
    const expected = truth.filter((item) => item.equipmentName === label);
    if (predicted.every((item) => item.boundingBox) && expected.every((item) => item.boundingBox)) {
      const pairs = predicted.flatMap((prediction, predictionIndex) => expected.flatMap((target, targetIndex) => {
        const overlap = iou(prediction.boundingBox!, target.boundingBox!);
        return overlap >= threshold ? [{ predictionIndex, targetIndex, overlap }] : [];
      })).sort((a, b) => b.overlap - a.overlap);
      const usedPredictions = new Set<number>();
      const usedTargets = new Set<number>();
      for (const pair of pairs) {
        if (usedPredictions.has(pair.predictionIndex) || usedTargets.has(pair.targetIndex)) continue;
        usedPredictions.add(pair.predictionIndex);
        usedTargets.add(pair.targetIndex);
        matches += 1;
      }
    } else {
      // If model or hand labels do not include boxes, score object counts per
      // canonical class; never collapse separate instances into one label.
      matches += Math.min(predicted.length, expected.length);
    }
  }
  return matches;
}

function metricCounts() { return { truePositives: 0, falsePositives: 0, falseNegatives: 0, predicted: 0, groundTruth: 0 }; }

function ratio(numerator: number, denominator: number, emptyValue: number): number {
  return denominator ? numerator / denominator : emptyValue;
}

async function run(): Promise<void> {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Manifest;
  const counts = metricCounts();
  const results: Array<Record<string, unknown>> = [];
  const apiErrors: Array<Record<string, unknown>> = [];
  const configurationIssues: Array<Record<string, unknown>> = [];
  let scoredFrames = 0;
  let plannedFrames = 0;
  let availableImages = 0;
  let missingImages = 0;
  let framesAttempted = 0;

  for (const testCase of manifest.cases) {
    const imagePaths = testCase.frames ?? (testCase.image ? [testCase.image] : []);
    plannedFrames += imagePaths.length;
    const frameResults: Array<Record<string, unknown>> = [];
    if (imagePaths.length === 0) {
      results.push({ id: testCase.id, category: testCase.category, status: "missing_image", notes: testCase.notes, frames: [] });
      continue;
    }

    let missingImage = false;
    for (let index = 0; index < imagePaths.length; index += 1) {
      const imagePath = imagePaths[index];
      const resolvedImagePath = safeRelativePath(imagePath);
      let image: Buffer;
      try { image = await fs.readFile(resolvedImagePath); }
      catch {
        missingImages += 1;
        missingImage = true;
        frameResults.push({ frame: index + 1, image: imagePath, status: "missing_image" });
        continue;
      }

      availableImages += 1;
      if (!apiBaseUrl || !bearerToken) {
        frameResults.push({ frame: index + 1, image: imagePath, status: "missing_api_configuration" });
        configurationIssues.push({ caseId: testCase.id, frame: index + 1, missing: [!apiBaseUrl && "VISION_EVAL_API_BASE", !bearerToken && "VISION_EVAL_BEARER_TOKEN"].filter(Boolean) });
        continue;
      }

      const startedAt = Date.now();
      framesAttempted += 1;
      let response: Response;
      let rawApiResponse: unknown;
      let responseJson = false;
      try {
        response = await fetch(`${apiBaseUrl}/equipment/detect`, {
          method: "POST",
          headers: { Authorization: `Bearer ${bearerToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ imageBase64: image.toString("base64") }),
          signal: AbortSignal.timeout(65_000),
        });
        const body = await response.text();
        try { rawApiResponse = JSON.parse(body); responseJson = true; } catch { rawApiResponse = body; }
      } catch (error) {
        const detail = error instanceof Error ? error.message : "request failed";
        const item = { caseId: testCase.id, frame: index + 1, image: imagePath, category: testCase.category, kind: "network_or_timeout", message: detail };
        apiErrors.push(item);
        frameResults.push({ ...item, status: "api_error", clientLatencyMs: Date.now() - startedAt });
        continue;
      }

      const clientLatencyMs = Date.now() - startedAt;
      const payload = rawApiResponse && typeof rawApiResponse === "object" ? rawApiResponse as Record<string, unknown> : {};
      const frameResult: Record<string, unknown> = {
        frame: index + 1,
        image: imagePath,
        status: response.ok ? "completed" : "api_error",
        httpStatus: response.status,
        prompt: payload.promptLabels ?? null,
        provider: payload.provider ?? null,
        clientLatencyMs,
        serverLatencyMs: payload.latencyMs ?? null,
        detectedLabels: Array.isArray(payload.detections) ? (payload.detections as Detection[]).map((detection) => detection.equipmentName) : [],
        detections: payload.detections ?? [],
        rawApiResponse,
      };

      if (!response.ok) {
        apiErrors.push({ caseId: testCase.id, frame: index + 1, category: testCase.category, httpStatus: response.status, response: rawApiResponse });
      } else if (!responseJson || !rawApiResponse || typeof rawApiResponse !== "object") {
        const item = { caseId: testCase.id, frame: index + 1, category: testCase.category, kind: "invalid_api_response", response: rawApiResponse };
        apiErrors.push(item);
        frameResult.status = "api_error";
      } else if (payload.configured === false) {
        const issue = { caseId: testCase.id, frame: index + 1, provider: payload.provider ?? null, message: payload.message ?? "Vision provider is not configured." };
        configurationIssues.push(issue);
        frameResult.status = "provider_not_configured";
      } else if (manifest.expectedProvider && payload.provider !== manifest.expectedProvider) {
        const issue = { caseId: testCase.id, frame: index + 1, expected: manifest.expectedProvider, actual: payload.provider ?? null };
        configurationIssues.push(issue);
        frameResult.configurationIssue = "provider_mismatch";
      } else {
        const truth = testCase.groundTruthByFrame?.[index] ?? (imagePaths.length === 1 ? testCase.groundTruth : null);
        if (Array.isArray(truth)) {
          const predicted = Array.isArray(payload.detections) ? payload.detections as Detection[] : [];
          const tp = matchLabels(predicted, truth, manifest.iouThreshold ?? iouThreshold);
          counts.truePositives += tp;
          counts.predicted += predicted.length;
          counts.groundTruth += truth.length;
          counts.falsePositives += predicted.length - tp;
          counts.falseNegatives += truth.length - tp;
          scoredFrames += 1;
          frameResult.groundTruth = truth;
          frameResult.metrics = { truePositives: tp, falsePositives: predicted.length - tp, falseNegatives: truth.length - tp };
        } else {
          frameResult.status = "completed_unscored_ground_truth_pending";
        }
      }
      frameResults.push(frameResult);
    }

    const status = frameResults.length > 0 && frameResults.every((frame) => frame.status === "missing_image")
      ? "missing_image"
      : missingImage ? "partial_missing_images" : "completed_or_blocked";
    results.push({ id: testCase.id, category: testCase.category, status, notes: testCase.notes, frames: frameResults });
  }

  const precision = ratio(counts.truePositives, counts.predicted, counts.groundTruth === 0 ? 1 : 0);
  const recall = ratio(counts.truePositives, counts.groundTruth, counts.predicted === 0 ? 1 : 0);
  const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
  const report = {
    generatedAt: new Date().toISOString(),
    target: apiBaseUrl ?? null,
    expectedProvider: manifest.expectedProvider ?? null,
    promptSource: "Returned promptLabels from the production equipment API; generated from canonical Equipment rows and aliases.",
    counts: {
      cases: manifest.cases.length,
      plannedFrames,
      availableImages,
      missingImages,
      framesAttempted,
      scoredFrames,
      unscoredFrames: Math.max(0, availableImages - scoredFrames),
    },
    metrics: scoredFrames ? { precision, recall, f1, ...counts, iouThreshold: manifest.iouThreshold ?? iouThreshold } : null,
    apiErrors,
    configurationIssues,
    liveScanCases: (manifest.liveScanCases ?? []).map((item: any) => ({ ...item, status: "manual_not_run" })),
    results,
  };

  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Equipment vision report written to ${path.relative(process.cwd(), reportPath)}`);
  console.log(`Cases: ${manifest.cases.length}; frames defined: ${plannedFrames}; missing images: ${missingImages}; API requests: ${framesAttempted}; scored frames: ${scoredFrames}; API errors: ${apiErrors.length}; configuration issues: ${configurationIssues.length}`);
  console.log(scoredFrames ? `Precision ${(precision * 100).toFixed(1)}% · Recall ${(recall * 100).toFixed(1)}% · F1 ${(f1 * 100).toFixed(1)}%` : "Metrics not calculated: no image frames with manually labeled ground truth were scored.");
}

run().catch((error) => {
  console.error(`Equipment vision evaluation could not run: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
