/**
 * Equipment-vision provider abstraction. Point the camera at your gym
 * corner, snap a photo, and get back which known Equipment rows are
 * actually visible — instead of manually ticking checkboxes.
 *
 * Supports two modes:
 *
 * 1. **Roboflow Workflow (RECOMMENDED)** — uses serverless inference endpoint
 *    Set ROBOFLOW_WORKFLOW_MODE=true in .env and provide ROBOFLOW_API_KEY
 *    Workflow: het-mehta/general-segmentation-api-5
 *    Endpoint: https://serverless.roboflow.com
 *
 * 2. **Roboflow Hosted Models (LEGACY)** — for backward compatibility
 *    Set ROBOFLOW_MODEL=<model_id/version> and ROBOFLOW_API_KEY in .env
 *    Examples:
 *      ROBOFLOW_MODEL=lifttrack/4              — detects: barbell, dumbbell (85% mAP@50)
 *      ROBOFLOW_MODEL=dumbbell-detection/3     — detects: dumbbell only (64% mAP@50)
 *
 * Browse more at https://universe.roboflow.com/search?q=class%3Adumbbell
 *
 * No key configured -> returns an honest "not configured" result, same
 * pattern as src/maps/provider.ts and src/ai/provider.ts. Never invents a
 * detection.
 */

import { RoboflowWorkflowProvider } from "./roboflowWorkflowProvider";

export interface EquipmentDetection {
  equipmentName: string; // matches a name in the Equipment table
  confidence: number; // 0-1
  rawLabel: string; // whatever the model called it
  boundingBox?: { x: number; y: number; width: number; height: number };
}

export interface EquipmentVisionProvider {
  detectEquipment(imageBase64: string): Promise<{ configured: boolean; detections: EquipmentDetection[] }>;
}

// Model class names -> our Equipment table names. Extend this if you swap
// in a model with more/different classes.
const EQUIPMENT_LABEL_MAP: Record<string, string> = {
  dumbbell: "Dumbbells",
  dumbbells: "Dumbbells",
  barbell: "Barbell",
  bench: "Bench",
  "pull-up bar": "Pull-up Bar",
  "pullup bar": "Pull-up Bar",
  "resistance band": "Resistance Bands",
  "resistance bands": "Resistance Bands",
  "cable machine": "Cable Machine",
  cable: "Cable Machine",
  "seated row": "Cable Machine",
  "chest press": "Cable Machine",
  "shoulder press": "Cable Machine",
  "squat rack": "Squat Rack",
  "leg extension": "Leg Press",
  "leg curl": "Leg Press",
  "preacher curl": "Bench",
  "assisted pull-up": "Pull-up Bar",
  "assisted pullup": "Pull-up Bar",
  treadmill: "Treadmill",
  "exercise bike": "Exercise Bike",
  "smith machine": "Smith Machine",
  "leg press": "Leg Press",
  "lat pulldown": "Lat Pulldown",
  kettlebell: "Dumbbells", // closest existing category in our seed data
};

export class MockEquipmentVisionProvider implements EquipmentVisionProvider {
  async detectEquipment(): Promise<{ configured: boolean; detections: EquipmentDetection[] }> {
    return { configured: false, detections: [] };
  }
}

/**
 * Roboflow Workflow provider — integrates the custom Roboflow workflow
 * with serverless inference endpoint.
 */
export class RoboflowEquipmentWorkflowProvider implements EquipmentVisionProvider {
  private workflowProvider: RoboflowWorkflowProvider;

  constructor(apiKey: string) {
    this.workflowProvider = new RoboflowWorkflowProvider(apiKey);
  }

  async detectEquipment(imageBase64: string): Promise<{ configured: boolean; detections: EquipmentDetection[] }> {
    try {
      const detections = await this.workflowProvider.detectEquipment(
        imageBase64,
        EQUIPMENT_LABEL_MAP
      );
      return { configured: true, detections };
    } catch (e: any) {
      throw new Error(`Roboflow workflow failed: ${e.message}`);
    }
  }
}

/**
 * Legacy Roboflow hosted model provider — kept for backward compatibility.
 * Prefers workflow mode if enabled.
 */
export class RoboflowEquipmentVisionProvider implements EquipmentVisionProvider {
  constructor(private apiKey: string, private modelId: string) {}

  async detectEquipment(imageBase64: string): Promise<{ configured: boolean; detections: EquipmentDetection[] }> {
    const url = `https://detect.roboflow.com/${this.modelId}?api_key=${encodeURIComponent(this.apiKey)}&confidence=35`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: imageBase64,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Roboflow inference failed (${res.status}): ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      predictions?: { class: string; confidence: number; x?: number; y?: number; width?: number; height?: number }[];
    };
    const predictions = data.predictions ?? [];

    // Dedupe by mapped equipment name, keeping the highest confidence seen.
    const best = new Map<string, EquipmentDetection>();
    for (const p of predictions) {
      const mapped = EQUIPMENT_LABEL_MAP[p.class.toLowerCase().trim()];
      if (!mapped) continue; // unmapped class — ignore rather than guess
      const existing = best.get(mapped);
      if (!existing || p.confidence > existing.confidence) {
        best.set(mapped, {
          equipmentName: mapped,
          confidence: p.confidence,
          rawLabel: p.class,
          boundingBox: p.x == null || p.y == null || p.width == null || p.height == null
            ? undefined
            : { x: p.x, y: p.y, width: p.width, height: p.height },
        });
      }
    }

    return { configured: true, detections: Array.from(best.values()) };
  }
}

export function getEquipmentVisionProvider(): EquipmentVisionProvider {
  const apiKey = process.env.ROBOFLOW_API_KEY;
  
  // Workflow mode (RECOMMENDED) — uses serverless endpoint
  if (process.env.ROBOFLOW_WORKFLOW_MODE === "true" && apiKey) {
    return new RoboflowEquipmentWorkflowProvider(apiKey);
  }

  // Hosted model mode (LEGACY) — for backward compatibility
  const modelId = process.env.ROBOFLOW_MODEL;
  if (apiKey && modelId) {
    return new RoboflowEquipmentVisionProvider(apiKey, modelId);
  }

  // No API key configured — use mock
  return new MockEquipmentVisionProvider();
}
