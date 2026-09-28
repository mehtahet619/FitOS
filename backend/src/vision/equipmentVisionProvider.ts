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

import { db } from "../db/client";
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

// Fallback mapping for legacy Roboflow hosted models (class names -> equipment names)
const FALLBACK_EQUIPMENT_LABEL_MAP: Record<string, string> = {
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
  kettlebell: "Dumbbells",
};

// SAM3 text prompts for equipment detection
// Keys are the text prompts sent to SAM3, values are the canonical equipment names
const SAM3_EQUIPMENT_PROMPTS: Record<string, string> = {
  "chest press machine": "Chest Press",
  "machine chest press": "Chest Press",
  "seated chest press": "Chest Press",
  "pec deck machine": "Pec Deck",
  "pec deck": "Pec Deck",
  "butterfly machine": "Pec Deck",
  "lat pulldown machine": "Lat Pulldown",
  "lat pulldown": "Lat Pulldown",
  "pulldown machine": "Lat Pulldown",
  "seated row machine": "Cable Machine",
  "cable machine": "Cable Machine",
  "cable crossover": "Cable Machine",
  "functional trainer": "Cable Machine",
  "leg press machine": "Leg Press",
  "leg press": "Leg Press",
  "seated leg press": "Leg Press",
  "leg extension machine": "Leg Extension",
  "leg extension": "Leg Extension",
  "seated leg extension": "Leg Extension",
  "leg curl machine": "Leg Curl",
  "leg curl": "Leg Curl",
  "seated leg curl": "Leg Curl",
  "lying leg curl": "Leg Curl",
  "standing leg curl": "Leg Curl",
  "shoulder press machine": "Machine",
  "smith machine": "Smith Machine",
  "squat rack": "Squat Rack",
  "power rack": "Squat Rack",
  "barbell": "Barbell",
  "dumbbells": "Dumbbells",
  "bench": "Bench",
  "flat bench": "Bench",
  "adjustable bench": "Bench",
  "incline bench": "Bench",
  "decline bench": "Bench",
  "treadmill": "Treadmill",
  "running machine": "Treadmill",
  "exercise bike": "Exercise Bike",
  "stationary bike": "Exercise Bike",
  "spin bike": "Exercise Bike",
  "cycling machine": "Exercise Bike",
  "elliptical": "Exercise Bike",
  "kettlebell": "Kettlebells",
  "kettlebells": "Kettlebells",
  "medicine ball": "Medicine Ball",
  "med ball": "Medicine Ball",
  "wall ball": "Medicine Ball",
  "exercise ball": "Exercise Ball",
  "stability ball": "Exercise Ball",
  "swiss ball": "Exercise Ball",
  "yoga ball": "Exercise Ball",
  "ez curl bar": "EZ Curl Bar",
  "ez bar": "EZ Curl Bar",
  "curl bar": "EZ Curl Bar",
  "foam roller": "Foam Roller",
  "foam roll": "Foam Roller",
  "roller": "Foam Roller",
  "pull-up bar": "Pull-up Bar",
  "pullup bar": "Pull-up Bar",
  "chin-up bar": "Pull-up Bar",
  "chinup bar": "Pull-up Bar",
  "pull up station": "Pull-up Bar",
  "resistance bands": "Resistance Bands",
  "resistance band": "Resistance Bands",
  "exercise bands": "Resistance Bands",
  "loop bands": "Resistance Bands",
  "tube bands": "Resistance Bands",
  "assisted pull-up": "Assisted Pull-up",
  "assisted pullup": "Assisted Pull-up",
  "assisted chin-up": "Assisted Pull-up",
  "assisted chinup": "Assisted Pull-up",
  "pull-up assist machine": "Assisted Pull-up",
  "preacher curl": "Preacher Curl",
  "preacher curl bench": "Preacher Curl",
  "preacher bench": "Preacher Curl",
};

let equipmentAliasCache: Map<string, string> | null = null;

async function loadEquipmentAliases(): Promise<Map<string, string>> {
  if (equipmentAliasCache) return equipmentAliasCache;

  const map = new Map<string, string>();
  try {
    const rows = await db.all<{ alias: string; equipmentId: string }>(
      `SELECT alias, equipmentId FROM EquipmentAlias`
    );
    const equipmentNames = new Map<string, string>();
    const equipmentRows = await db.all<{ id: string; name: string }>(
      `SELECT id, name FROM Equipment`
    );
    for (const eq of equipmentRows) {
      equipmentNames.set(eq.id, eq.name);
    }
    for (const row of rows) {
      const equipmentName = equipmentNames.get(row.equipmentId);
      if (equipmentName) {
        map.set(row.alias.toLowerCase().trim(), equipmentName);
      }
    }
    equipmentAliasCache = map;
  } catch (e) {
    console.warn("Failed to load equipment aliases from database, using fallback:", e);
  }
  return map;
}

function normalizeLabel(label: string): string {
  return label.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, " ");
}

async function mapDetectionLabel(label: string): Promise<string | null> {
  const normalized = normalizeLabel(label);
  const aliases = await loadEquipmentAliases();

  // Try exact match first
  if (aliases.has(normalized)) {
    return aliases.get(normalized)!;
  }

  // Try fuzzy match - check if any alias is contained in the label or vice versa
  for (const [alias, equipmentName] of aliases.entries()) {
    if (normalized.includes(alias) || alias.includes(normalized)) {
      return equipmentName;
    }
  }

  // Fallback to hardcoded map
  return FALLBACK_EQUIPMENT_LABEL_MAP[normalized] || null;
}

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
      const rawDetections = await this.workflowProvider.detectEquipment(
        imageBase64,
        SAM3_EQUIPMENT_PROMPTS
      );
      const detections: EquipmentDetection[] = [];
      for (const d of rawDetections) {
        const mapped = await mapDetectionLabel(d.rawLabel);
        if (mapped) {
          detections.push({ ...d, equipmentName: mapped });
        }
      }
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
      const mapped = await mapDetectionLabel(p.class);
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
