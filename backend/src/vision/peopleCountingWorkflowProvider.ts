/**
 * Client for the published FitOS-independent Roboflow people-counting workflow.
 * The workflow definition declares one image input and one JSON output, "predictions".
 * Keep the returned output generic so future workflow output changes do not get
 * silently coerced into an assumed detection schema.
 */
export const PEOPLE_COUNTING_WORKSPACE = "het-mehta";
export const PEOPLE_COUNTING_WORKFLOW =
  "people-counting-vpeople-counting-nxg8y-k3wzi-1-rfdetr-small-t1-logic";
const ENDPOINT = `https://serverless.roboflow.com/${PEOPLE_COUNTING_WORKSPACE}/workflows/${PEOPLE_COUNTING_WORKFLOW}`;

export type WorkflowImage =
  | { type: "url"; value: string }
  | { type: "base64"; value: string };

export type PeopleCountingOutput = Record<string, unknown>;

export class RoboflowWorkflowError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly retryable = false
  ) {
    super(message);
    this.name = "RoboflowWorkflowError";
  }
}

export interface PeopleCountingOptions {
  timeoutMs?: number;
  maxRetries?: number;
  parameters?: Record<string, unknown>;
}

/**
 * Run people-counting inference for one image. API credentials are read only
 * from ROBOFLOW_API_KEY and sent in the Authorization header, never the body.
 */
export async function runPeopleCountingWorkflow(
  image: WorkflowImage,
  options: PeopleCountingOptions = {}
): Promise<PeopleCountingOutput> {
  const apiKey = process.env.ROBOFLOW_API_KEY?.trim();
  if (!apiKey) {
    throw new RoboflowWorkflowError(
      "ROBOFLOW_API_KEY is not configured. Set it in the backend environment."
    );
  }
  if (image.type === "url" && !/^https:\/\//i.test(image.value)) {
    throw new RoboflowWorkflowError("Roboflow image URLs must use HTTPS.");
  }
  if (!image.value.trim()) {
    throw new RoboflowWorkflowError("The workflow image value cannot be empty.");
  }

  const timeoutMs = Math.max(1000, options.timeoutMs ?? 30_000);
  const maxRetries = Math.min(2, Math.max(0, options.maxRetries ?? 2));
  const body = {
    inputs: {
      image: { type: image.type, value: image.value },
    },
    ...(options.parameters ? { parameters: options.parameters } : {}),
  };

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const details = (await response.text().catch(() => "")).slice(0, 300);
        const retryable = response.status === 429 || response.status >= 500;
        const error = new RoboflowWorkflowError(
          `Roboflow people-counting workflow failed (HTTP ${response.status})${details ? `: ${details}` : ""}`,
          response.status,
          retryable
        );
        if (!retryable || attempt === maxRetries) throw error;
        lastError = error;
      } else {
        const payload: unknown = await response.json();
        const result = Array.isArray(payload)
          ? payload[0]
          : isRecord(payload) && Array.isArray(payload.outputs)
            ? payload.outputs[0]
            : payload;
        if (!isRecord(result)) {
          throw new RoboflowWorkflowError(
            "Roboflow returned an unexpected response: expected an output object."
          );
        }
        // The MCP execution returned one dictionary per input image. Some REST
        // deployments wrap that list in { outputs: [...] }, so both are handled.
        return result;
      }
    } catch (error) {
      if (error instanceof RoboflowWorkflowError) {
        if (!error.retryable || attempt === maxRetries) throw error;
        lastError = error;
      } else {
        const timedOut = error instanceof Error && error.name === "AbortError";
        lastError = new RoboflowWorkflowError(
          timedOut
            ? `Roboflow people-counting request timed out after ${timeoutMs}ms.`
            : `Roboflow people-counting request failed: ${error instanceof Error ? error.message : "unknown error"}`,
          undefined,
          true
        );
        if (attempt === maxRetries) throw lastError;
      }
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** attempt));
  }
  throw lastError instanceof Error
    ? lastError
    : new RoboflowWorkflowError("Roboflow people-counting inference failed.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
