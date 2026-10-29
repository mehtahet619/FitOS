/**
 * Live smoke test for the published Roboflow workflow.
 * Run from backend/: npx ts-node scripts/smoke-people-counting-workflow.ts
 * Requires ROBOFLOW_API_KEY. This makes a real inference request.
 */
import {
  PEOPLE_COUNTING_WORKFLOW,
  runPeopleCountingWorkflow,
} from "../src/vision/peopleCountingWorkflowProvider";

async function main(): Promise<void> {
  const output = await runPeopleCountingWorkflow({
    type: "url",
    value: "https://media.roboflow.com/inference/people-walking.jpg",
  });
  const outputKeys = Object.keys(output);
  if (outputKeys.length === 0) {
    throw new Error("Smoke test failed: workflow returned no output keys.");
  }
  // Grounded in the workflow's saved definition and a successful live run.
  if (!Object.prototype.hasOwnProperty.call(output, "predictions")) {
    throw new Error(
      `Smoke test failed for ${PEOPLE_COUNTING_WORKFLOW}: expected "predictions"; got ${outputKeys.join(", ")}`
    );
  }
  const predictions = output.predictions as { predictions?: unknown[] } | undefined;
  if (!predictions || !Array.isArray(predictions.predictions)) {
    throw new Error('Smoke test failed: "predictions" did not contain a predictions array.');
  }
  console.log(
    `Roboflow smoke test passed: output keys=[${outputKeys.join(", ")}], detections=${predictions.predictions.length}`
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Smoke test failed.");
  process.exitCode = 1;
});
