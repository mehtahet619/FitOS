import { db } from "../db/client";

export interface EquipmentDetection {
  equipmentName: string;
  confidence: number;
  rawLabel: string;
  boundingBox?: { x: number; y: number; width: number; height: number };
}

export interface EquipmentVisionProvider {
  detectEquipment(imageBase64: string): Promise<{
    configured: boolean;
    detections: EquipmentDetection[];
    provider: string;
    error?: string;
    latencyMs?: number;
    rawDetectionCount?: number;
  }>;
  getProviderName(): string;
}

export type EquipmentMode = "SCANNED" | "FULL_GYM";

export function getEquipmentModeConfig(): { mode: EquipmentMode; confidenceThreshold: number } {
  const rawMode = process.env.EQUIPMENT_MODE?.toUpperCase();
  const mode: EquipmentMode = rawMode === "SCANNED" ? "SCANNED" : "FULL_GYM";
  const parsed = Number.parseFloat(process.env.EQUIPMENT_DETECTION_CONFIDENCE_THRESHOLD ?? "0.50");
  return { mode, confidenceThreshold: Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0.5 };
}

const LABELS: Record<string, string> = {
  dumbbell: "Dumbbells", dumbbells: "Dumbbells", "lat pull down machine": "Lat Pulldown",
  "lat pulldown machine": "Lat Pulldown", "lat pulldown": "Lat Pulldown", "leg press machine": "Leg Press",
  "leg press": "Leg Press", "chest press machine": "Chest Press", "machine chest press": "Chest Press",
  "chest press": "Chest Press", "cable crossover": "Cable Machine", "cable station": "Cable Machine",
  "functional trainer": "Cable Machine", "cable machine": "Cable Machine", "chest fly machine": "Pec Deck",
  "seated row machine": "Cable Machine", "shoulder press machine": "Machine", "lateral raises machine": "Machine",
  "leg curl machine": "Leg Curl", "leg extension machine": "Leg Extension", "smith machine": "Smith Machine",
  "ab crunch machine": "Machine", "abdominal bench": "Bench", "back extension machine": "Machine",
  "hack squat machine": "Leg Press", "seated dip machine": "Machine", "leg raise tower": "Pull-up Bar",
  "stability ball": "Exercise Ball", "stationary bike": "Exercise Bike", bench: "Bench", barbell: "Barbell",
  kettlebells: "Kettlebells", treadmill: "Treadmill", elliptical: "Exercise Bike", stepmill: "Treadmill",
  "preacher curl": "Preacher Curl", "ghd machine": "Machine", "ab roller": "Foam Roller",
};

function normalize(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

async function canonicalEquipmentName(label: string): Promise<string | null> {
  const normalized = normalize(label);
  const aliasRows = await db.all<{ alias: string; name: string }>(
    `SELECT ea.alias, e.name FROM EquipmentAlias ea JOIN Equipment e ON e.id = ea.equipmentId`
  ).catch(() => []);
  const exactAlias = aliasRows.find((row) => normalize(row.alias) === normalized);
  const exactMap = LABELS[normalized];
  const resolved = exactAlias?.name ?? exactMap;
  if (!resolved) return null;
  const exactEquipment = await db.get<{ name: string }>(`SELECT name FROM Equipment WHERE lower(name) = lower(?)`, resolved);
  return exactEquipment?.name ?? null;
}

export class BestEquipmentVisionProvider implements EquipmentVisionProvider {
  readonly modelId = process.env.EQUIPMENT_VISION_MODEL_ID || "all-gym-equipment/2";
  private readonly apiUrl = process.env.EQUIPMENT_VISION_API_URL || "https://serverless.roboflow.com";
  constructor(private readonly apiKey = process.env.EQUIPMENT_VISION_API_KEY || "") {}

  getProviderName(): string { return `roboflow-universe:${this.modelId}`; }

  async detectEquipment(imageBase64: string) {
    if (!this.apiKey) return { configured: false, detections: [], provider: this.getProviderName(), error: "EQUIPMENT_VISION_API_KEY is not configured" };
    const started = Date.now();
    const modelId = this.modelId.replace(/^\/+|\/+$/g, "");
    const response = await fetch(`${this.apiUrl.replace(/\/$/, "")}/${modelId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: imageBase64.replace(/^data:image\/[^;]+;base64,/, ""),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Vision API returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const data = await response.json() as { predictions?: Array<{ class?: string; confidence?: number; x?: number; y?: number; width?: number; height?: number }> };
    const raw = Array.isArray(data.predictions) ? data.predictions : [];
    const threshold = getEquipmentModeConfig().confidenceThreshold;
    const parsed: EquipmentDetection[] = [];
    for (const prediction of raw) {
      const confidence = Number(prediction.confidence);
      if (!prediction.class || !Number.isFinite(confidence) || confidence < threshold) continue;
      const equipmentName = await canonicalEquipmentName(prediction.class);
      if (!equipmentName) continue;
      const box = [prediction.x, prediction.y, prediction.width, prediction.height];
      parsed.push({
        equipmentName, confidence, rawLabel: prediction.class,
        boundingBox: box.every((v) => Number.isFinite(v)) ? { x: prediction.x!, y: prediction.y!, width: prediction.width!, height: prediction.height! } : undefined,
      });
    }
    // Detector-side NMS handles overlapping boxes. Collapse repeated class detections
    // for the equipment-availability set, retaining the strongest observation.
    const unique = new Map<string, EquipmentDetection>();
    for (const detection of parsed) {
      const existing = unique.get(detection.equipmentName);
      if (!existing || detection.confidence > existing.confidence) unique.set(detection.equipmentName, detection);
    }
    console.info(JSON.stringify({ event: "equipment_detection", provider: this.getProviderName(), rawDetections: raw.length, normalizedEquipment: [...new Set(parsed.map((d) => d.equipmentName))], filteredDetections: unique.size, latencyMs: Date.now() - started }));
    return { configured: true, detections: [...unique.values()], provider: this.getProviderName(), latencyMs: Date.now() - started, rawDetectionCount: raw.length };
  }
}

export class MockEquipmentVisionProvider implements EquipmentVisionProvider {
  async detectEquipment() { return { configured: false, detections: [], provider: "unconfigured", error: "EQUIPMENT_VISION_API_KEY is not configured" }; }
  getProviderName() { return "unconfigured"; }
}

export class FullGymEquipmentProvider implements EquipmentVisionProvider {
  async detectEquipment() {
    const rows = await db.all<{ name: string }>(`SELECT name FROM Equipment WHERE name != 'No Equipment'`);
    return { configured: true, detections: rows.map((row) => ({ equipmentName: row.name, confidence: 1, rawLabel: "full_gym_mode" })), provider: "full_gym" };
  }
  getProviderName() { return "full_gym"; }
}

export function getEquipmentVisionProvider(): EquipmentVisionProvider {
  return getEquipmentModeConfig().mode === "FULL_GYM"
    ? new FullGymEquipmentProvider()
    : process.env.EQUIPMENT_VISION_API_KEY
      ? new BestEquipmentVisionProvider()
      : new MockEquipmentVisionProvider();
}
