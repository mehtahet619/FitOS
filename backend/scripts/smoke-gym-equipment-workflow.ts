/**
 * Live smoke test for the All Gym Equipment Workflow.
 * Run from backend/: npx ts-node scripts/smoke-gym-equipment-workflow.ts
 * Requires ROBOFLOW_API_KEY. Uses a public gym photo URL only for smoke testing;
 * FitOS webcam usage sends sampled frames from the browser automatically.
 */
const WORKSPACE = "het-mehta";
const WORKFLOW = "all-gym-equipment-vall-gym-equipment-yhr3r-1-yolov8n-t3-logic";
const ENDPOINT = `https://serverless.roboflow.com/${WORKSPACE}/workflows/${WORKFLOW}`;

async function main(): Promise<void> {
  const apiKey = process.env.ROBOFLOW_API_KEY?.trim();
  if (!apiKey) throw new Error("Set ROBOFLOW_API_KEY in backend/.env before running this smoke test.");

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      inputs: {
        image: {
          type: "url",
          value: "https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=1280&q=80",
        },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const details = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`Workflow smoke test failed (HTTP ${response.status})${details ? `: ${details}` : ""}`);
  }

  const payload: unknown = await response.json();
  const first = Array.isArray(payload) ? payload[0] : payload;
  if (!isRecord(first)) throw new Error("Workflow smoke test failed: expected an output object.");
  const output = Array.isArray(first.outputs) && isRecord(first.outputs[0]) ? first.outputs[0] : first;
  if (!Object.prototype.hasOwnProperty.call(output, "predictions")) {
    throw new Error(`Workflow smoke test failed: expected declared output "predictions"; got ${Object.keys(output).join(", ")}`);
  }
  const value = output.predictions;
  const predictions = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.predictions)
      ? value.predictions
      : null;
  if (!predictions) throw new Error('Workflow smoke test failed: "predictions" output did not contain a predictions array.');
  console.log(`Roboflow Workflow smoke test passed. Output keys: ${Object.keys(output).join(", ")}. Detections: ${predictions.length}.`);
  if (predictions.length === 0) {
    console.warn("The workflow ran successfully but detected no equipment in the smoke-test image. Validate with your actual gym webcam.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Workflow smoke test failed.");
  process.exitCode = 1;
});
