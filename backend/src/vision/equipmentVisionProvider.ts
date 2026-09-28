/**
 * Equipment-vision provider abstraction.
 *
 * Point the camera at your gym corner, snap a photo, and get back
 * which known Equipment rows are actually visible.
 *
 * Supports two modes:
 *
 * 1. Roboflow Workflow (RECOMMENDED)
 *    Uses serverless inference endpoint.
 *    Set ROBOFLOW_WORKFLOW_MODE=true in .env and provide ROBOFLOW_API_KEY.
 *
 * 2. Roboflow Hosted Models (LEGACY)
 *    For backward compatibility.
 *    Set ROBOFLOW_MODEL=<model_id/version> and ROBOFLOW_API_KEY.
 *
 * No key configured -> returns an honest "not configured" result.
 * Never invents a detection.
 */

import { db } from "../db/client";
import { RoboflowWorkflowProvider } from "./roboflowWorkflowProvider";

export interface EquipmentDetection {
  equipmentName: string;
  confidence: number;
  rawLabel: string;
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface EquipmentVisionProvider {
  detectEquipment(
    imageBase64: string
  ): Promise<{
    configured: boolean;
    detections: EquipmentDetection[];
  }>;
}

/**
 * Fallback mapping for legacy Roboflow hosted models
 * and labels that cannot be resolved through EquipmentAlias.
 */
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

  "chest press": "Chest Press",

  "shoulder press": "Machine",

  "squat rack": "Squat Rack",

  "leg extension": "Leg Extension",

  "leg curl": "Leg Curl",

  "preacher curl": "Preacher Curl",

  "assisted pull-up": "Assisted Pull-up",
  "assisted pullup": "Assisted Pull-up",

  treadmill: "Treadmill",

  "exercise bike": "Exercise Bike",

  "smith machine": "Smith Machine",

  "leg press": "Leg Press",

  "lat pulldown": "Lat Pulldown",

  kettlebell: "Kettlebells",
};

/**
 * SAM3 text prompts for equipment detection.
 *
 * Keys are the text prompts sent to SAM3.
 * Values are the canonical equipment names used by FitOS.
 */
const SAM3_EQUIPMENT_PROMPTS: Record<string, string> = {
  // Chest
  "chest press machine": "Chest Press",
  "machine chest press": "Chest Press",
  "seated chest press": "Chest Press",

  // Pec Deck
  "pec deck machine": "Pec Deck",
  "pec deck": "Pec Deck",
  "butterfly machine": "Pec Deck",

  // Back
  "lat pulldown machine": "Lat Pulldown",
  "lat pulldown": "Lat Pulldown",
  "pulldown machine": "Lat Pulldown",

  "seated row machine": "Cable Machine",

  // Cable
  "cable machine": "Cable Machine",
  "cable crossover": "Cable Machine",
  "functional trainer": "Cable Machine",

  // Legs
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

  // Shoulders
  "shoulder press machine": "Machine",

  // Smith / rack
  "smith machine": "Smith Machine",
  "squat rack": "Squat Rack",
  "power rack": "Squat Rack",

  // Free weights
  barbell: "Barbell",

  dumbbells: "Dumbbells",

  bench: "Bench",
  "flat bench": "Bench",
  "adjustable bench": "Bench",
  "incline bench": "Bench",
  "decline bench": "Bench",

  // Cardio
  treadmill: "Treadmill",
  "running machine": "Treadmill",

  "exercise bike": "Exercise Bike",
  "stationary bike": "Exercise Bike",
  "spin bike": "Exercise Bike",
  "cycling machine": "Exercise Bike",

  elliptical: "Exercise Bike",

  // Kettlebells
  kettlebell: "Kettlebells",
  kettlebells: "Kettlebells",

  // Medicine balls
  "medicine ball": "Medicine Ball",
  "med ball": "Medicine Ball",
  "wall ball": "Medicine Ball",

  // Exercise balls
  "exercise ball": "Exercise Ball",
  "stability ball": "Exercise Ball",
  "swiss ball": "Exercise Ball",
  "yoga ball": "Exercise Ball",

  // EZ bar
  "ez curl bar": "EZ Curl Bar",
  "ez bar": "EZ Curl Bar",
  "curl bar": "EZ Curl Bar",

  // Foam roller
  "foam roller": "Foam Roller",
  "foam roll": "Foam Roller",
  roller: "Foam Roller",

  // Pull-up
  "pull-up bar": "Pull-up Bar",
  "pullup bar": "Pull-up Bar",
  "chin-up bar": "Pull-up Bar",
  "chinup bar": "Pull-up Bar",
  "pull up station": "Pull-up Bar",

  // Resistance bands
  "resistance bands": "Resistance Bands",
  "resistance band": "Resistance Bands",
  "exercise bands": "Resistance Bands",
  "loop bands": "Resistance Bands",
  "tube bands": "Resistance Bands",

  // Assisted pull-up
  "assisted pull-up": "Assisted Pull-up",
  "assisted pullup": "Assisted Pull-up",
  "assisted chin-up": "Assisted Pull-up",
  "assisted chinup": "Assisted Pull-up",
  "pull-up assist machine": "Assisted Pull-up",

  // Preacher
  "preacher curl": "Preacher Curl",
  "preacher curl bench": "Preacher Curl",
  "preacher bench": "Preacher Curl",
};

let equipmentAliasCache: Map<string, string> | null = null;

/**
 * Load dynamic aliases from the database.
 *
 * EquipmentAlias:
 *   alias
 *   equipmentId
 *
 * Equipment:
 *   id
 *   name
 */
async function loadEquipmentAliases(): Promise<Map<string, string>> {
  if (equipmentAliasCache) {
    return equipmentAliasCache;
  }

  const map = new Map<string, string>();

  try {
    const rows = await db.all<{
      alias: string;
      equipmentId: string;
    }>(
      `SELECT alias, equipmentId FROM EquipmentAlias`
    );

    const equipmentNames = new Map<string, string>();

    const equipmentRows = await db.all<{
      id: string;
      name: string;
    }>(
      `SELECT id, name FROM Equipment`
    );

    for (const eq of equipmentRows) {
      equipmentNames.set(eq.id, eq.name);
    }

    for (const row of rows) {
      const equipmentName = equipmentNames.get(row.equipmentId);

      if (equipmentName) {
        map.set(
          row.alias.toLowerCase().trim(),
          equipmentName
        );
      }
    }

    equipmentAliasCache = map;
  } catch (e) {
    console.warn(
      "Failed to load equipment aliases from database, using fallback:",
      e
    );
  }

  return map;
}

/**
 * Normalize arbitrary model labels.
 */
function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Convert a model label into a canonical FitOS equipment name.
 *
 * Resolution order:
 *
 * 1. Database EquipmentAlias exact match
 * 2. Database EquipmentAlias fuzzy match
 * 3. SAM3 prompt mapping
 * 4. Legacy hardcoded fallback
 */
async function mapDetectionLabel(
  label: string
): Promise<string | null> {
  const normalized = normalizeLabel(label);

  /**
   * First use database aliases.
   */
  const aliases = await loadEquipmentAliases();

  if (aliases.has(normalized)) {
    return aliases.get(normalized)!;
  }

  /**
   * Fuzzy database alias matching.
   *
   * Example:
   * "large lat pulldown machine"
   *
   * can match:
   * "lat pulldown machine"
   */
  for (const [alias, equipmentName] of aliases.entries()) {
    if (
      normalized.includes(alias) ||
      alias.includes(normalized)
    ) {
      return equipmentName;
    }
  }

  /**
   * SAM3 prompt mapping.
   */
  if (SAM3_EQUIPMENT_PROMPTS[normalized]) {
    return SAM3_EQUIPMENT_PROMPTS[normalized];
  }

  /**
   * Fallback for legacy Roboflow models.
   */
  return FALLBACK_EQUIPMENT_LABEL_MAP[normalized] || null;
}

/**
 * Mock provider used when no vision provider is configured.
 */
export class MockEquipmentVisionProvider
  implements EquipmentVisionProvider
{
  async detectEquipment(): Promise<{
    configured: boolean;
    detections: EquipmentDetection[];
  }> {
    return {
      configured: false,
      detections: [],
    };
  }
}

/**
 * Roboflow Workflow provider.
 *
 * Uses the existing RoboflowWorkflowProvider and sends
 * SAM3 equipment prompts instead of the legacy class map.
 */
export class RoboflowEquipmentWorkflowProvider
  implements EquipmentVisionProvider
{
  private workflowProvider: RoboflowWorkflowProvider;

  constructor(apiKey: string) {
    this.workflowProvider =
      new RoboflowWorkflowProvider(apiKey);
  }

  async detectEquipment(
    imageBase64: string
  ): Promise<{
    configured: boolean;
    detections: EquipmentDetection[];
  }> {
    try {
      const rawDetections =
        await this.workflowProvider.detectEquipment(
          imageBase64,
          SAM3_EQUIPMENT_PROMPTS
        );

      const detections: EquipmentDetection[] = [];

      for (const d of rawDetections) {
        const mapped = await mapDetectionLabel(
          d.rawLabel
        );

        if (mapped) {
          detections.push({
            ...d,
            equipmentName: mapped,
          });
        }
      }

      /**
       * Dedupe detections by canonical equipment name.
       * Keep the highest confidence detection.
       */
      const best =
        new Map<string, EquipmentDetection>();

      for (const detection of detections) {
        const existing = best.get(
          detection.equipmentName
        );

        if (
          !existing ||
          detection.confidence >
            existing.confidence
        ) {
          best.set(
            detection.equipmentName,
            detection
          );
        }
      }

      return {
        configured: true,
        detections: Array.from(best.values()),
      };
    } catch (e: any) {
      throw new Error(
        `Roboflow workflow failed: ${
          e?.message || String(e)
        }`
      );
    }
  }
}

/**
 * Legacy Roboflow hosted-model provider.
 *
 * Kept for backward compatibility.
 */
export class RoboflowEquipmentVisionProvider
  implements EquipmentVisionProvider
{
  constructor(
    private apiKey: string,
    private modelId: string
  ) {}

  async detectEquipment(
    imageBase64: string
  ): Promise<{
    configured: boolean;
    detections: EquipmentDetection[];
  }> {
    const url =
      `https://detect.roboflow.com/${this.modelId}` +
      `?api_key=${encodeURIComponent(this.apiKey)}` +
      `&confidence=35`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
      },
      body: imageBase64,
    });

    if (!res.ok) {
      const text = await res
        .text()
        .catch(() => "");

      throw new Error(
        `Roboflow inference failed (${res.status}): ${text.slice(
          0,
          200
        )}`
      );
    }

    const data = (await res.json()) as {
      predictions?: Array<{
        class: string;
        confidence: number;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
      }>;
    };

    const predictions =
      data.predictions ?? [];

    /**
     * Dedupe by canonical equipment name.
     */
    const best =
      new Map<string, EquipmentDetection>();

    for (const p of predictions) {
      const mapped =
        await mapDetectionLabel(p.class);

      if (!mapped) {
        continue;
      }

      const existing = best.get(mapped);

      if (
        !existing ||
        p.confidence > existing.confidence
      ) {
        best.set(mapped, {
          equipmentName: mapped,
          confidence: p.confidence,
          rawLabel: p.class,
          boundingBox:
            p.x == null ||
            p.y == null ||
            p.width == null ||
            p.height == null
              ? undefined
              : {
                  x: p.x,
                  y: p.y,
                  width: p.width,
                  height: p.height,
                },
        });
      }
    }

    return {
      configured: true,
      detections: Array.from(best.values()),
    };
  }
}

/**
 * Select the configured equipment vision provider.
 */
export function getEquipmentVisionProvider():
  EquipmentVisionProvider {
  const apiKey =
    process.env.ROBOFLOW_API_KEY;

  /**
   * Workflow mode.
   */
  if (
    process.env.ROBOFLOW_WORKFLOW_MODE ===
      "true" &&
    apiKey
  ) {
    return new RoboflowEquipmentWorkflowProvider(
      apiKey
    );
  }

  /**
   * Legacy hosted-model mode.
   */
  const modelId =
    process.env.ROBOFLOW_MODEL;

  if (apiKey && modelId) {
    return new RoboflowEquipmentVisionProvider(
      apiKey,
      modelId
    );
  }

  /**
   * No provider configured.
   */
  return new MockEquipmentVisionProvider();
}