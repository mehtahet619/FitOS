import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { db } from "../db/client";
import { RoboflowWorkflowProvider } from "./roboflowWorkflowProvider";
import { RoboflowGymEquipmentWorkflowProvider } from "./roboflowGymEquipmentWorkflowProvider";
import { deduplicateOverlappingDetections } from "./detectionUtils";

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
    promptLabels?: string[];
  }>;
  getProviderName(): string;
}

export type EquipmentMode = "SCANNED" | "FULL_GYM";

export function getEquipmentModeConfig(): { mode: EquipmentMode; confidenceThreshold: number } {
  const rawMode = process.env.EQUIPMENT_MODE?.toUpperCase();
  const mode: EquipmentMode = rawMode === "FULL_GYM" ? "FULL_GYM" : "SCANNED";
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
  const resolved = aliasRows.find((row) => normalize(row.alias) === normalized)?.name ?? LABELS[normalized];
  if (!resolved) return null;
  const exactEquipment = await db.get<{ name: string }>(`SELECT name FROM Equipment WHERE lower(name) = lower(?)`, resolved);
  return exactEquipment?.name ?? null;
}

type RawPrediction = { class?: string; confidence?: number; x?: number; y?: number; width?: number; height?: number };
type WorkerResponse = { id: string; predictions?: RawPrediction[]; error?: string };

const projectRoot = resolve(__dirname, "../..");
const defaultModelCandidates = [
  process.env.EQUIPMENT_VISION_MODEL_PATH,
  resolve(projectRoot, "models/best.pt"),
  resolve(projectRoot, "models/best.onnx"),
].filter((value): value is string => Boolean(value));

export const missingModelError = `Equipment detection model not found. Set EQUIPMENT_VISION_MODEL_PATH or place best.pt/best.onnx in ${resolve(projectRoot, "models")}. Train/export with: yolo detect train data=path/to/data.yaml model=yolo11n.pt epochs=100; yolo export model=runs/detect/train/weights/best.pt format=onnx`;

class LocalYoloProvider implements EquipmentVisionProvider {
  private readonly modelPath = defaultModelCandidates.find(existsSync);
  private worker: ChildProcessWithoutNullStreams | null = null;
  private responses = new Map<string, (response: WorkerResponse) => void>();
  private startup: Promise<void> | null = null;

  getProviderName(): string { return `local-yolo:${this.modelPath ?? "not-configured"}`; }

  async initialize(): Promise<void> {
    if (this.startup) return this.startup;
    this.startup = this.startWorker();
    return this.startup;
  }

  private async startWorker(): Promise<void> {
    if (!this.modelPath) {
      console.error(`[CV] Model not configured: ${missingModelError}`);
      return;
    }
    const script = resolve(__dirname, "local_yolo_worker.py");
    this.worker = spawn(process.env.EQUIPMENT_VISION_PYTHON || "python3", [script, this.modelPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: this.worker.stdout });
    lines.on("line", (line) => {
      try {
        const response = JSON.parse(line) as WorkerResponse;
        const resolveResponse = this.responses.get(response.id);
        if (resolveResponse) {
          this.responses.delete(response.id);
          resolveResponse(response);
        }
      } catch (error) {
        console.error("[CV] Invalid local worker response:", error);
      }
    });
    this.worker.stderr.on("data", (data) => console.error(`[CV] Local model: ${String(data).trim()}`));
    this.worker.on("exit", (code) => {
      if (code !== 0) console.error(`[CV] Local model worker exited with code ${code}`);
      this.worker = null;
    });
    await new Promise<void>((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error("Local YOLO worker startup timed out")), 30_000);
      const onLine = (line: string) => {
        if (!line.startsWith("__READY__")) return;
        clearTimeout(timeout);
        this.worker?.stdout.off("data", onData);
        console.info(`[CV] Model loaded: ${this.modelPath}`);
        resolveReady();
      };
      const onData = (data: Buffer) => data.toString().split("\n").forEach(onLine);
      this.worker?.stdout.on("data", onData);
      this.worker?.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  async detectEquipment(imageBase64: string) {
    const started = Date.now();
    await this.initialize();
    if (!this.modelPath || !this.worker) {
      return { configured: false, detections: [], provider: this.getProviderName(), error: missingModelError };
    }
    console.info("[CV] Frame received");
    console.info("[CV] Running inference");
    const id = randomUUID();
    const response = await new Promise<WorkerResponse>((resolveResponse, reject) => {
      const timeout = setTimeout(() => {
        this.responses.delete(id);
        reject(new Error("Local YOLO inference timed out"));
      }, 30_000);
      this.responses.set(id, (result) => {
        clearTimeout(timeout);
        resolveResponse(result);
      });
      this.worker?.stdin.write(`${JSON.stringify({ id, imageBase64 })}\n`, (error) => {
        if (error) reject(error);
      });
    });
    if (response.error) throw new Error(response.error);
    const raw = response.predictions ?? [];
    console.info(`[CV] Raw detections: ${raw.length}`);
    const threshold = getEquipmentModeConfig().confidenceThreshold;
    const parsed: EquipmentDetection[] = [];
    for (const prediction of raw) {
      const confidence = Number(prediction.confidence);
      if (!prediction.class || !Number.isFinite(confidence) || confidence < threshold) continue;
      const equipmentName = await canonicalEquipmentName(prediction.class);
      if (!equipmentName) continue;
      parsed.push({
        equipmentName, confidence, rawLabel: prediction.class,
        boundingBox: [prediction.x, prediction.y, prediction.width, prediction.height].every((v) => Number.isFinite(v))
          ? { x: prediction.x!, y: prediction.y!, width: prediction.width!, height: prediction.height! } : undefined,
      });
    }
    console.info(`[CV] After confidence filtering: ${parsed.length}`);
    const detections = deduplicateOverlappingDetections(parsed);
    console.info(`[CV] Normalized equipment: ${JSON.stringify(detections.map((detection) => detection.equipmentName))}`);
    return { configured: true, detections, provider: this.getProviderName(), latencyMs: Date.now() - started, rawDetectionCount: raw.length };
  }
}

const localProvider = new LocalYoloProvider();
// Prefer hosted vision when its credential exists, avoiding a local YOLO provider
// that cannot work on Render without separately packaged model weights.
const roboflowWorkflowEnabled = () =>
  process.env.ROBOFLOW_WORKFLOW_MODE?.toLowerCase() === "true" ||
  Boolean(process.env.ROBOFLOW_API_KEY?.trim());

export function initializeEquipmentVisionProvider(): Promise<void> {
  return process.env.ROBOFLOW_GYM_EQUIPMENT_WORKFLOW_MODE?.toLowerCase() === "true" || roboflowWorkflowEnabled() || getEquipmentModeConfig().mode === "FULL_GYM"
    ? Promise.resolve()
    : localProvider.initialize();
}

export function getEquipmentVisionProvider(): EquipmentVisionProvider {
  if (process.env.ROBOFLOW_GYM_EQUIPMENT_WORKFLOW_MODE?.toLowerCase() === "true") {
    return new RoboflowGymEquipmentWorkflowProvider();
  }
  if (getEquipmentModeConfig().mode === "FULL_GYM") return new FullGymEquipmentProvider();
  if (roboflowWorkflowEnabled()) {
    const apiKey = process.env.ROBOFLOW_API_KEY;
    return apiKey ? new RoboflowWorkflowEquipmentProvider(apiKey) : new MissingRoboflowConfigurationProvider();
  }
  return localProvider;
}

/** Builds prompts only for canonical equipment rows present in this database. */
async function getRoboflowEquipmentLabelMap(): Promise<Record<string, string>> {
  const [equipment, aliases] = await Promise.all([
    db.all<{ id: string; name: string }>(`SELECT id,name FROM Equipment WHERE name != 'No Equipment'`),
    db.all<{ alias: string; name: string }>(`SELECT ea.alias,e.name FROM EquipmentAlias ea JOIN Equipment e ON e.id=ea.equipmentId`),
  ]);
  const canonicalByNormalizedName = new Map(equipment.map((item) => [normalize(item.name), item.name]));
  const labelMap: Record<string, string> = {};
  for (const item of equipment) labelMap[normalize(item.name)] = item.name;
  for (const [alias, name] of Object.entries(LABELS)) {
    const canonicalName = canonicalByNormalizedName.get(normalize(name));
    if (canonicalName) labelMap[normalize(alias)] = canonicalName;
  }
  // Curated per-database aliases are authoritative when they differ from a
  // generic built-in fallback mapping.
  for (const alias of aliases) labelMap[normalize(alias.alias)] = alias.name;
  return labelMap;
}

class RoboflowWorkflowEquipmentProvider implements EquipmentVisionProvider {
  private readonly workflow: RoboflowWorkflowProvider;

  constructor(apiKey: string) { this.workflow = new RoboflowWorkflowProvider(apiKey); }

  getProviderName(): string { return "roboflow-workflow-sam3"; }

  async detectEquipment(imageBase64: string) {
    const promptMap = await getRoboflowEquipmentLabelMap();
    const started = Date.now();
    const detections = await this.workflow.detectEquipment(imageBase64, promptMap);
    return {
      configured: true,
      detections,
      provider: this.getProviderName(),
      latencyMs: Date.now() - started,
      promptLabels: Object.keys(promptMap),
    };
  }
}

class MissingRoboflowConfigurationProvider implements EquipmentVisionProvider {
  getProviderName(): string { return "roboflow-workflow-sam3"; }
  async detectEquipment() {
    return {
      configured: false,
      detections: [],
      provider: this.getProviderName(),
      error: "Roboflow workflow mode requires ROBOFLOW_API_KEY.",
    };
  }
}

export class FullGymEquipmentProvider implements EquipmentVisionProvider {
  async detectEquipment() {
    const rows = await db.all<{ name: string }>(`SELECT name FROM Equipment WHERE name != 'No Equipment'`);
    return { configured: true, detections: rows.map((row) => ({ equipmentName: row.name, confidence: 1, rawLabel: "full_gym_mode" })), provider: "full_gym" };
  }
  getProviderName() { return "full_gym"; }
}
