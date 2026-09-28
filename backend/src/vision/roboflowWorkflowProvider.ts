/**
 * Roboflow Workflow provider — uses the serverless inference endpoint
 * instead of hosted models. This integrates your Roboflow workflow:
 *
 * Workspace: het-mehta
 * Workflow: general-segmentation-api-5
 * Endpoint: https://serverless.roboflow.com/het-mehta/workflows/general-segmentation-api-5
 *
 * The workflow processes an image and returns detections in its own output format.
 * This provider handles retry logic, timeout management, and defensive parsing.
 */

import type { EquipmentDetection } from "./equipmentVisionProvider";

interface WorkflowRequest {
  inputs: {
    image: {
      type: "base64" | "url";
      value: string;
    };
    prompts?: { type: "text"; text: string }[];
  };
}

interface WorkflowResponse {
  [key: string]: any;
}

export class RoboflowWorkflowProvider {
  private readonly workspaceSlug = "het-mehta";
  private readonly workflowId = "general-segmentation-api-5";
  private readonly endpoint = "https://serverless.roboflow.com";
  private readonly timeoutMs = 30000;
  private readonly maxRetries = 2;

  constructor(private apiKey: string) {}

  /**
   * Detect equipment in an image using the Roboflow workflow.
   * Expects base64-encoded image, returns parsed detections.
   *
   * @param imageBase64 raw base64 string (no data: prefix)
   * @returns detections with equipmentName, confidence, and rawLabel
   * @throws if request fails after retries or timeout
   */
  async detectEquipment(
    imageBase64: string,
    equipmentLabelMap: Record<string, string>
  ): Promise<EquipmentDetection[]> {
    const url = `${this.endpoint}/${this.workspaceSlug}/workflows/${this.workflowId}`;

    // Pass all equipment class names as text prompts for SAM3
    const prompts = Object.keys(equipmentLabelMap).map(text => ({ type: "text" as const, text }));

    const payload: WorkflowRequest = {
      inputs: {
        image: {
          type: "base64",
          value: imageBase64,
        },
        prompts,
      },
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.fetchWithTimeout(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(
            `Roboflow workflow returned ${response.status}: ${text.slice(0, 200)}`
          );
        }

        const data = (await response.json()) as WorkflowResponse;

        // Parse detections defensively from workflow output
        // The workflow returns a list of results (one per input image)
        // Each result contains the workflow's output keys
        const detections = this.parseWorkflowOutput(data, equipmentLabelMap);
        return detections;
      } catch (e: any) {
        lastError = e;
        if (attempt < this.maxRetries) {
          // Exponential backoff: 100ms, 300ms
          await new Promise((resolve) =>
            setTimeout(resolve, 100 * Math.pow(3, attempt))
          );
        }
      }
    }

    throw lastError || new Error("Roboflow workflow detection failed: unknown error");
  }

  /**
   * Execute fetch with timeout.
   * Fetch doesn't have native timeout, so we wrap it with Promise.race.
   */
  private fetchWithTimeout(
    url: string,
    init: RequestInit
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    return fetch(url, { ...init, signal: controller.signal })
      .finally(() => clearTimeout(timeoutId))
      .catch((e) => {
        if (e.name === "AbortError") {
          throw new Error(
            `Roboflow workflow request timed out after ${this.timeoutMs}ms`
          );
        }
        throw e;
      });
  }

  /**
   * Parse workflow response defensively.
   *
   * The workflow output structure depends on your workflow definition.
   * This implementation handles common detection output formats:
   * - Array of predictions with class/confidence
   * - Nested results with predictions field
   * - Direct object with predictions field
   *
   * Extend this if your workflow has a different output structure.
   */
  private parseWorkflowOutput(
    data: WorkflowResponse,
    equipmentLabelMap: Record<string, string>
  ): EquipmentDetection[] {
    const detections: EquipmentDetection[] = [];

    // Handle array response (workflow returns list of results)
    let predictions: any[] = [];
    if (Array.isArray(data)) {
      // If it's an array of results, extract predictions from first result
      if (data.length > 0) {
        predictions = this.extractPredictions(data[0]);
      }
    } else {
      // If it's an object, extract predictions directly
      predictions = this.extractPredictions(data);
    }

    // Dedupe by mapped equipment name, keeping highest confidence
    const best = new Map<string, EquipmentDetection>();
    for (const pred of predictions) {
      const rawClass = pred.class || pred.name || pred.label || "";
      if (!rawClass) continue;

      const mapped = equipmentLabelMap[rawClass.toLowerCase().trim()];
      if (!mapped) continue; // Skip unmapped classes

      const confidence = pred.confidence || 0;
      const existing = best.get(mapped);
      if (!existing || confidence > existing.confidence) {
        best.set(mapped, {
          equipmentName: mapped,
          confidence: Math.min(1, Math.max(0, confidence)), // Clamp to 0-1
          rawLabel: rawClass,
          boundingBox: this.boundingBoxFor(pred),
        });
      }
    }

    return Array.from(best.values());
  }

  private boundingBoxFor(prediction: any): EquipmentDetection["boundingBox"] {
    const x = Number(prediction.x);
    const y = Number(prediction.y);
    const width = Number(prediction.width);
    const height = Number(prediction.height);
    if (![x, y, width, height].every(Number.isFinite)) return undefined;
    return { x, y, width, height };
  }

  /**
   * Extract predictions array from workflow output object.
   * Handles various nesting levels and field names.
   */
  private extractPredictions(result: any): any[] {
    if (!result || typeof result !== "object") return [];

    // Direct predictions array
    if (Array.isArray(result.predictions)) return result.predictions;

    // Nested under detection/detections
    if (Array.isArray(result.detection)) return result.detection;
    if (Array.isArray(result.detections)) return result.detections;

    // Check for other common output keys in workflows
    for (const key of Object.keys(result)) {
      if (Array.isArray(result[key]) && result[key].length > 0) {
        // Check if this looks like a predictions array
        // (has objects with class/confidence-like fields)
        const first = result[key][0];
        if (
          first &&
          typeof first === "object" &&
          ("class" in first || "name" in first || "confidence" in first)
        ) {
          return result[key];
        }
      }
    }

    return [];
  }
}
