/**
 * Roboflow live gym-equipment Workflow adapter.
 *
 * The browser supplies sampled webcam frames to the authenticated
 * POST /equipment/detect route. This adapter sends each frame to the saved
 * Workflow's image input; it does not expose the Roboflow key to the browser.
 */
import type { EquipmentDetection, EquipmentVisionProvider } from "./equipmentVisionProvider";
import { deduplicateOverlappingDetections } from "./detectionUtils";

const WORKSPACE = "het-mehta";
const WORKFLOW = "all-gym-equipment-vall-gym-equipment-yhr3r-1-yolov8n-t3-logic";
const ENDPOINT = `https://serverless.roboflow.com/${WORKSPACE}/workflows/${WORKFLOW}`;

type Prediction = {
  class?: unknown;
  name?: unknown;
  label?: unknown;
  confidence?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
};

type JsonRecord = Record<string, unknown>;

export class RoboflowGymEquipmentWorkflowProvider implements EquipmentVisionProvider {
  getProviderName(): string {
    return "roboflow-workflow-all-gym-equipment";
  }

  async detectEquipment(imageBase64: string) {
    const apiKey = process.env.ROBOFLOW_API_KEY?.trim();
    if (!apiKey) {
      return {
        configured: false,
        detections: [],
        provider: this.getProviderName(),
        error: "Gym equipment Workflow mode requires ROBOFLOW_API_KEY.",
      };
    }
    if (!imageBase64 || imageBase64.length < 100) {
      throw new Error("A non-empty base64 webcam frame is required.");
    }

    const started = Date.now();
    const timeoutMs = 30_000;
    const maxRetries = 2;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            inputs: {
              image: { type: "base64", value: imageBase64 },
            },
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const detail = (await response.text().catch(() => "")).slice(0, 250);
          const retryable = response.status === 429 || response.status >= 500;
          const error = new Error(
            `Roboflow gym-equipment Workflow failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`
          );
          if (!retryable || attempt === maxRetries) throw error;
          lastError = error;
        } else {
          const payload: unknown = await response.json();
          const output = extractWorkflowOutput(payload);
          const predictions = extractPredictions(output);
          const thresholdValue = Number.parseFloat(process.env.EQUIPMENT_DETECTION_CONFIDENCE_THRESHOLD ?? "0.50");
          const threshold = Number.isFinite(thresholdValue) ? Math.max(0, Math.min(1, thresholdValue)) : 0.5;
          const detections: EquipmentDetection[] = [];

          for (const prediction of predictions) {
            const rawLabel = stringValue(prediction.class ?? prediction.name ?? prediction.label);
            const confidence = Number(prediction.confidence);
            if (!rawLabel || !Number.isFinite(confidence) || confidence < threshold || confidence > 1) continue;
            // Roboflow is the source of truth for visual labels. Do not
            // filter predictions through FitOS's equipment catalogue: gym
            // machines vary by brand/model and may not exist in our database.
            const equipmentName = rawLabel;
            const values = [prediction.x, prediction.y, prediction.width, prediction.height].map(Number);
            const boundingBox = values.every(Number.isFinite) && values[2] > 0 && values[3] > 0
              ? { x: values[0], y: values[1], width: values[2], height: values[3] }
              : undefined;
            detections.push({ equipmentName, confidence, rawLabel, boundingBox });
          }

          return {
            configured: true,
            detections: deduplicateOverlappingDetections(detections),
            provider: this.getProviderName(),
            latencyMs: Date.now() - started,
            rawDetectionCount: predictions.length,
          };
        }
      } catch (error) {
        lastError = error;
        if (attempt === maxRetries || (error instanceof Error && /HTTP 4\d\d/.test(error.message) && !/HTTP 429/.test(error.message))) {
          throw error;
        }
      } finally {
        clearTimeout(timeout);
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** attempt));
    }

    throw lastError instanceof Error ? lastError : new Error("Roboflow gym-equipment Workflow failed.");
  }
}

function extractWorkflowOutput(payload: unknown): JsonRecord {
  const first = Array.isArray(payload) ? payload[0] : payload;
  if (!isRecord(first)) throw new Error("Roboflow returned an unexpected workflow response.");
  // The published workflow's declared output is named "predictions".
  // Some REST responses wrap the per-image result in { outputs: [...] }.
  if (Array.isArray(first.outputs) && isRecord(first.outputs[0])) return first.outputs[0];
  return first;
}

function extractPredictions(output: JsonRecord): Prediction[] {
  const value = output.predictions;
  if (Array.isArray(value)) return value.filter(isRecord) as Prediction[];
  if (isRecord(value) && Array.isArray(value.predictions)) {
    return value.predictions.filter(isRecord) as Prediction[];
  }
  throw new Error('Roboflow response did not contain the declared "predictions" output with a predictions array.');
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
