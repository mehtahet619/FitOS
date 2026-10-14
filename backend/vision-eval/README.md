# Equipment vision evaluation

This harness calls the existing authenticated `POST /equipment/detect` API. It writes the unmodified backend JSON response, model/provider name, prompt labels, detections, confidence values, client/server latency, and errors to `latest-report.json`.

## What is and is not tested here

The manifest contains all 15 requested still-image scenarios and five live-camera scenarios. No representative real-gym test images or manually labeled ground truth are checked into this repository. The image paths are intentionally pending; the runner reports missing images and does not invent detections or accuracy scores. The live-camera cases remain manual because the API accepts one still image per request and does not expose occupancy detection.

Add each approved test photo under `vision-eval/images/`, update its `image` or `frames` path, and manually fill `groundTruth` with one entry per visible equipment object. Use canonical `Equipment.name` labels. An empty array is the correct ground truth for a verified no-equipment image. For multi-frame cases, use `groundTruthByFrame` to annotate each frame separately. Optional boxes use the model's center `x`, `y`, `width`, `height` coordinates. When both prediction and ground truth include boxes, the evaluator greedily matches same-label boxes at the configured IoU threshold; otherwise it compares per-label object counts without collapsing separate objects.

## Run against production

First verify in Render that `ROBOFLOW_WORKFLOW_MODE=true` and `ROBOFLOW_API_KEY` are configured for the **backend** service, and that the live deployment contains the Roboflow provider changes. The test report flags a provider mismatch rather than silently scoring YOLO output as SAM3.

From `backend/`, set the production API and a short-lived access token for an authorized FitOS account in your current terminal session, then run:

```powershell
$env:VISION_EVAL_API_BASE = "https://adaptive-fit-api.onrender.com"
$tokenSecure = Read-Host "Paste short-lived access token (hidden)" -AsSecureString
$tokenBstr = [IntPtr]::Zero
try {
  $tokenBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($tokenSecure)
  $env:VISION_EVAL_BEARER_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenBstr)
  npm run vision:eval
} finally {
  if ($tokenBstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenBstr) }
  Remove-Item Env:VISION_EVAL_BEARER_TOKEN, Env:VISION_EVAL_API_BASE -ErrorAction SilentlyContinue
}
```

Do not commit tokens or real user photos. The report contains raw API responses, so review it before sharing. Use `VISION_EVAL_MANIFEST` or `VISION_EVAL_REPORT` to select alternate paths under this directory.

## Metrics and errors

Precision, recall, and F1 are micro-averaged over frames with manually labeled ground truth only. An empty ground-truth list makes every predicted item a false positive. Missing images and missing credentials are configuration/input blockers, not model errors. Non-success HTTP responses, timeouts, and network failures are recorded under `apiErrors` and are not counted as false positives or false negatives. A successful response with zero detections is a model result and is scored normally.

## Live Scan checklist

Run the five `liveScanCases` from the manifest through the authenticated Gym Tour camera flow. Record the run manually in the report or attach a separate video/frame set. Equipment recognition is distinct from occupancy: this detector returns equipment labels only. A person near or using a machine is not an occupancy result.
