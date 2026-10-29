# Backend — Adaptive Fit API

Express + TypeScript + Node's built-in `node:sqlite` module (no native
compilation, no external DB server — just `npm install`). Requires Node
22.5+. See the top-level `README.md` for
the quickstart. This file is the API reference.

## Setup

```bash
npm install
cp .env.example .env
npm run migrate
npm run seed
npm run dev      # http://localhost:4000
npm test         # unit tests for the substitution engine, macro calc, ranking
```

## Render deployment

The repository includes a `render.yaml` blueprint for the Render web service.
Set `FRONTEND_ORIGIN` to the deployed frontend URL. The Render API start
command applies the idempotent TiDB/MySQL schema migration before serving
traffic. Normal server starts do not run seed scripts. Configure Resend and
Upstash Redis secrets in Render before enabling email OTP flows.

The API selects TiDB/MySQL automatically for `mysql://`, `mysql2://`, or
`tidb://` URLs, PostgreSQL for `postgres://` or `postgresql://`, and SQLite
remains available only for local development. An unsupported `DATABASE_URL`
scheme fails startup instead of silently using SQLite. OTP request limits use an atomic shared Upstash Redis token
bucket in production.

```bash
DATABASE_URL="mysql://..." npm run migrate:mysql
```

For the compiled production migration used by Render:

```bash
npm run build
DATABASE_URL="mysql://..." npm run migrate:mysql:prod
```

The equivalent TiDB connection URL can use the `tidb://` scheme; the backend
normalizes it for the MySQL driver:

```bash
npm run build
DATABASE_URL="tidb://..." npm run migrate:mysql:prod
```


## Environment variables (`.env`)

| Var | Purpose |
|---|---|
| `DATABASE_URL` | `file:./dev.db` by default. Swap `schema.sql` provider conventions to Postgres for production. |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Change these before any real deployment. |
| `OTP_HASH_SECRET` | HMAC key used to hash one-time codes. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Atomic shared OTP rate-limit store. |
| `RESEND_API_KEY`, `EMAIL_FROM` | Transactional email delivery through Resend's HTTPS API. |
| `OTP_HASH_SECRET` | HMAC key used to hash one-time codes. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Atomic shared OTP rate-limit store. |
| `RESEND_API_KEY`, `EMAIL_FROM` | Transactional email delivery through Resend's HTTPS API. |
| `AI_PROVIDER` | `template` (default, no key needed) — see `src/ai/provider.ts` to add a real one. |
| `MAPS_PROVIDER` | `mock` (default, returns honest empty results) or `apify_swiggy` — see **Food Discovery** below. |
| `ROBOFLOW_WORKFLOW_MODE` | `true` for serverless workflows (recommended), `false` or unset for legacy hosted models — see **Equipment Vision** below. |
| `ROBOFLOW_API_KEY` | Your Roboflow workspace API key. Get from https://app.roboflow.com/settings/api |
| `APIFY_API_KEY` | Your Apify account API token. Get from https://apify.com — required for Swiggy integration. |

## Endpoints

### Auth
- `POST /auth/register/request-otp` `{ name, email, password }`
- `POST /auth/register/resend-otp` `{ email }`
- `POST /auth/register/verify-otp` `{ email, otp }`
- `POST /auth/login` `{ email, password }`
- `POST /auth/login/request-otp` `{ email }` and `POST /auth/login/verify-otp` `{ email, otp }` — email-code sign-in for verified accounts
- `GET /auth/me` session restoration
- `POST /auth/refresh` rotating refresh session
- `POST /auth/logout` (auth)
- `POST /auth/password/request-otp` and `POST /auth/password/reset`
- `POST /auth/google` — stub, returns 501 with wiring notes

### User
- `GET /user/profile` (auth)
- `PUT /user/profile` (auth) — also completes onboarding and (re)computes nutrition targets

### Equipment
- `GET /equipment` — full catalog, for onboarding checkboxes
- `GET /user/equipment` (auth)
- `POST /user/equipment` (auth) `{ equipmentNames: string[] }` — replaces the user's full set; unknown names are created as custom equipment
- `POST /equipment/detect` (auth) `{ imageBase64: string }` — camera-based equipment detection + exercise suggestions with how-to instructions (see top-level README's "Equipment vision" section for setup); returns `configured: false` with an honest message if no vision model is wired up

### Exercises
- `GET /exercises?muscle=chest`
- `GET /exercises/:id`
- `GET /exercises/:id/substitutions`

### Workouts — the core differentiator
- `POST /workouts/generate` (auth) `{ focus?, dayIndex? }`
- `GET /workouts/today` (auth)
- `POST /workouts/:id/complete-set` (auth) `{ workoutExerciseId, setNumber, weightKg?, reps? }`
- `POST /workouts/:id/complete` (auth)
- `POST /workouts/:id/replace-exercise` (auth) `{ workoutExerciseId, reason: "no_equipment" | "pain" | "user_preference" }` — **"I don't have this equipment" → immediate, muscle-preserving substitution**
- `POST /workouts/:id/skip-exercise` (auth) `{ workoutExerciseId }`
- `POST /workouts/:id/report-pain` (auth) `{ workoutExerciseId }` — returns a safety warning, never a diagnosis

### Nutrition
- `POST /nutrition/generate` (auth)
- `GET /nutrition/today` (auth)

### Food discovery
- `GET /food/nearby?lat=&lng=&foodId=` (auth) — returns `configured: false` and an honest empty state unless a real `MapsProvider` is wired up; **never invents restaurant data**
- `GET /food/search?q=` (auth)

### Progress
- `GET /progress/dashboard` (auth)
- `POST /progress/metric` (auth) `{ metric, value }`

### Gym attendance
- `GET /gym/today` (auth)
- `POST /gym/checkin` (auth) `{ method: "qr" | "manual" }` — **409 if already checked in today** (one entry per user per calendar date, enforced by a DB unique constraint)
- `GET /gym/history` (auth)

## Design notes

- **Deterministic core, AI on top.** Equipment matching, substitution
  selection, macro math, and restaurant ranking are all pure functions with
  unit tests (`src/__tests__/engine.test.ts`). The AI provider
  (`src/ai/provider.ts`) is only ever used to phrase an explanation of a
  result that was already computed — never to decide the result itself.
- **Substitution engine never breaks the muscle-group promise.**
  `pickSubstitute()` in `src/modules/exercises/substitutionEngine.ts`
  returns `null` rather than a substitute that doesn't share the base
  exercise's primary muscle group — see the corresponding test.

## Integrations

### Equipment Vision — local detector by default, Roboflow SAM3 when enabled

The default `SCANNED` provider is a local Ultralytics YOLO model. The model is
loaded once by a persistent Python worker; camera frames are sent from the
backend to that worker over stdin/stdout. To explicitly select the existing
Roboflow SAM3 Workflow instead, set `ROBOFLOW_WORKFLOW_MODE=true` and provide
`ROBOFLOW_API_KEY`. When Roboflow mode is enabled but its key is missing, the
API reports that the provider is not configured; it does not silently run a
different model.

Configure:

```env
EQUIPMENT_MODE="SCANNED"
EQUIPMENT_VISION_MODEL_PATH="models/best.pt"
EQUIPMENT_VISION_PYTHON="python3"
EQUIPMENT_DETECTION_CONFIDENCE_THRESHOLD="0.50"
ROBOFLOW_WORKFLOW_MODE="false"
ROBOFLOW_API_KEY=""
```

Install the worker dependencies with `python3 -m pip install -r vision-requirements.txt`.
If no model exists, the API returns `MODEL_NOT_CONFIGURED` and the UI shows
“Model not configured” rather than reporting zero detections. To train/export:

```bash
yolo detect train data=path/to/data.yaml model=yolo11n.pt epochs=100
yolo export model=runs/detect/train/weights/best.pt format=onnx
cp runs/detect/train/weights/best.pt backend/models/best.pt
```
Detection only determines available equipment; target muscles and exercise
selection remain owned by the existing workout-plan and CSV flow.

### Roboflow SAM3 Workflow (opt-in)

Integrates the Roboflow serverless workflow for real-time gym equipment detection from images.

**Workflow Details:**
- Workspace: `het-mehta`
- Workflow ID: `general-segmentation-api-5`
- Endpoint: `https://serverless.roboflow.com/het-mehta/workflows/general-segmentation-api-5`
- Auth: `Authorization: Bearer <API_KEY>` header

**Setup:**

1. Get your Roboflow API key from https://app.roboflow.com/settings/api
2. Add these environment variables to the backend (for production, use the
   Render backend service's Environment page and redeploy):
   ```
   ROBOFLOW_WORKFLOW_MODE="true"
   ROBOFLOW_API_KEY="your_api_key_here"
   ```
3. The workflow accepts base64-encoded images and returns structured detection results
4. Provider location: `src/vision/roboflowWorkflowProvider.ts`

**How it works:**
- `POST /equipment/detect` accepts a base64-encoded image
- Roboflow workflow processes it and returns equipment detections
- Prompt labels are built from canonical `Equipment` rows, aliases, and the
  known label mappings. Unknown classes are ignored rather than guessed.
- Multiple same-label objects are preserved. Only near-identical overlapping
  same-label boxes (IoU >= 0.92) are merged; separate benches/stations remain
  separate detections.
- Results suggest applicable exercises based on detected equipment
- Handles retries with exponential backoff and 30-second timeout

**Troubleshooting:**
- If workflow returns 401/403, verify API key in `.env`
- If no detections: try better lighting, clearer angle, or verify workflow is trained
- Check the backend logs and Roboflow workflow run history for errors. API
  responses include the provider, prompt labels, and inference latency.

The detector recognizes equipment; it does not determine whether a person is
using or occupying a machine. Use `vision-eval/manifest.json` and
`npm run vision:eval` to evaluate real images with manually labeled ground
truth. Do not report precision/recall/F1 until those labels and images exist.

### Food Discovery — Apify Swiggy Scraper

Discovers nearby restaurants on Swiggy with menu items and estimated pricing.

**Setup:**

1. Sign up free at https://apify.com (no credit card required)
2. Generate an API token from Account Settings
3. Add to `.env`:
   ```
   MAPS_PROVIDER="apify_swiggy"
   APIFY_API_KEY="your_api_token_here"
   ```
4. Provider location: `src/maps/apifySwiggyProvider.ts`

**How it works:**
- `GET /food/nearby?lat=<latitude>&lng=<longitude>&foodId=<query>` triggers a Swiggy search
- Apify actor scrapes restaurants for the given location and cuisine
- Results include distance (Haversine formula), rating, price range
- Menu items have estimated calories and protein based on category heuristics
- Returns top 10 closest restaurants, sorted by distance

**Features:**
- Automatic distance calculation from user coordinates
- Price range estimation (₹ to ₹₹₹₹)
- Calorie/protein estimation for menu items (heuristic-based)
- Polling-based actor run completion (60-second timeout)
- Graceful fallback to empty results on error (never invents data)

**Extending:**
- To add real nutrition data: integrate with FatSecret API or USDA FoodData Central
- To support other restaurants: create similar Apify wrapper for Swiggy alternatives

---

## Legacy: Roboflow Hosted Models

If you prefer the simpler hosted model approach (without workflows), set:
```
ROBOFLOW_WORKFLOW_MODE="false"
ROBOFLOW_MODEL="lifttrack/4"
ROBOFLOW_API_KEY="your_key"
```

Public models available at https://universe.roboflow.com/search?q=class%3Adumbbell


## People-counting Roboflow Workflow (image-only)

A separate client is available at `src/vision/peopleCountingWorkflowProvider.ts` for the published workflow:

- Workspace: `het-mehta`
- Workflow slug: `people-counting-vpeople-counting-nxg8y-k3wzi-1-rfdetr-small-t1-logic`
- Input: `image` (`url` or base64)
- Output observed from the saved definition and live run: `predictions`, containing image dimensions and a `predictions` array with boxes, class labels, and confidence values.

This is an image inference client, not a live webcam/RTSP/video-stream integration. It is independent of the existing equipment detection provider and does not add or change an HTTP route.

Set `ROBOFLOW_API_KEY` in the backend environment. The key is sent in the `Authorization: Bearer` header and is never included in the request body. Do not commit the key. Example from backend code:

```ts
import { runPeopleCountingWorkflow } from "./vision/peopleCountingWorkflowProvider";

const output = await runPeopleCountingWorkflow({
  type: "base64",
  value: imageBase64, // raw base64, without a data-URL prefix
});
const result = output.predictions; // preserve the workflow's own output shape
```

Run the live smoke test from `backend/` after setting `ROBOFLOW_API_KEY`:

```bash
npx ts-node scripts/smoke-people-counting-workflow.ts
```

The smoke test makes a real Roboflow inference request using a public sample image. It checks that the workflow returns its declared output. Network access and valid Roboflow credentials are required.
