type Outcome = "success" | "error";
const buckets = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30];
const detectionCounts: Record<Outcome, number> = { success: 0, error: 0 };
const feedbackCounts: Record<"CONFIRMED" | "REJECTED", number> = { CONFIRMED: 0, REJECTED: 0 };
const latencyBuckets = new Map<number, number>(buckets.map((bucket) => [bucket, 0]));
let latencySum = 0;
let latencyCount = 0;
let rawPredictions = 0;
let acceptedPredictions = 0;

export function recordEquipmentInference(input: { outcome: Outcome; latencyMs: number; rawPredictions?: number; acceptedPredictions?: number }): void {
  detectionCounts[input.outcome] += 1;
  const seconds = Math.max(0, input.latencyMs / 1000);
  latencySum += seconds;
  latencyCount += 1;
  for (const bucket of buckets) if (seconds <= bucket) latencyBuckets.set(bucket, (latencyBuckets.get(bucket) ?? 0) + 1);
  rawPredictions += Math.max(0, input.rawPredictions ?? 0);
  acceptedPredictions += Math.max(0, input.acceptedPredictions ?? 0);
}
export function recordEquipmentFeedback(verdict: "CONFIRMED" | "REJECTED"): void {
  feedbackCounts[verdict] += 1;
}
export function renderEquipmentPrometheusMetrics(): string {
  const lines = [
    "# HELP fitos_equipment_inference_total Gym equipment inference requests by outcome.",
    "# TYPE fitos_equipment_inference_total counter",
    ...Object.entries(detectionCounts).map(([outcome, value]) => `fitos_equipment_inference_total{outcome="${outcome}"} ${value}`),
    "# HELP fitos_equipment_inference_duration_seconds Roboflow inference duration.",
    "# TYPE fitos_equipment_inference_duration_seconds histogram",
    ...buckets.map((bucket) => `fitos_equipment_inference_duration_seconds_bucket{le="${bucket}"} ${latencyBuckets.get(bucket) ?? 0}`),
    `fitos_equipment_inference_duration_seconds_bucket{le="+Inf"} ${latencyCount}`,
    `fitos_equipment_inference_duration_seconds_sum ${latencySum}`,
    `fitos_equipment_inference_duration_seconds_count ${latencyCount}`,
    "# HELP fitos_equipment_predictions_total Raw and accepted model predictions.",
    "# TYPE fitos_equipment_predictions_total counter",
    `fitos_equipment_predictions_total{stage="raw"} ${rawPredictions}`,
    `fitos_equipment_predictions_total{stage="accepted"} ${acceptedPredictions}`,
    "# HELP fitos_equipment_feedback_total User-reviewed detections.",
    "# TYPE fitos_equipment_feedback_total counter",
    ...Object.entries(feedbackCounts).map(([verdict, value]) => `fitos_equipment_feedback_total{verdict="${verdict}"} ${value}`),
  ];
  return lines.join("\n") + "\n";
}