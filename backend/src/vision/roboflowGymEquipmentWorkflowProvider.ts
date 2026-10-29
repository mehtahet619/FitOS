/**
 * Roboflow live gym-equipment Workflow adapter.
 *
 * The browser supplies sampled webcam frames to the authenticated
 * POST /equipment/detect route. This adapter sends each frame to the saved
 * Workflow's image input; it does not expose the Roboflow key to the browser.
 */
import type { EquipmentDetection, EquipmentVisionProvider } from "./equipmentVisionProvider";
import { deduplicateOverlappingDetections } from "./detectionUtils";
import { db } from "../db/client.js";

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
          const labelMap = await getLabelMap();
          const thresholdValue = Number.parseFloat(process.env.EQUIPMENT_DETECTION_CONFIDENCE_THRESHOLD ?? "0.50");
          const threshold = Number.isFinite(thresholdValue) ? Math.max(0, Math.min(1, thresholdValue)) : 0.5;
          const detections: EquipmentDetection[] = [];

          for (const prediction of predictions) {
            const rawLabel = stringValue(prediction.class ?? prediction.name ?? prediction.label);
            const confidence = Number(prediction.confidence);
            if (!rawLabel || !Number.isFinite(confidence) || confidence < threshold || confidence > 1) continue;
            const equipmentName = labelMap[normalize(rawLabel)];
            if (!equipmentName) continue;
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
            promptLabels: Object.keys(labelMap),
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

async function getLabelMap(): Promise<Record<string, string>> {
  // Query existing canonical equipment and curated aliases. Never invent a
  // database equipment name or expose a model class as an unsupported item.
  const [equipment, aliases] = await Promise.all([
    db.all<{ name: string }>(`SELECT name FROM Equipment WHERE name != 'No Equipment'`),
    db.all<{ alias: string; name: string }>(
      `SELECT ea.alias, e.name FROM EquipmentAlias ea JOIN Equipment e ON e.id = ea.equipmentId`
    ).catch(() => []),
  ]);
  const canonical = new Map(equipment.map((item) => [normalize(item.name), item.name] as const));
  const map: Record<string, string> = {};
  for (const item of equipment) map[normalize(item.name)] = item.name;
  for (const alias of aliases) map[normalize(alias.alias)] = alias.name;
  return Object.fromEntries(
    Object.entries(map).filter(([, name]) => canonical.has(normalize(name)))
  );
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
