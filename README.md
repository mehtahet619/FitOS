# Adaptive Fit — Equipment-Aware Fitness + Food Discovery MVP

> "Tell us what equipment you have. We'll figure out the workout."

A working MVP: adaptive equipment-aware workout generation, deterministic
nutrition planning, an honest (never-invented) nearby-food layer, a
MediaPipe-powered Vision Coach for rep counting + form feedback, and
one-per-day gym attendance check-in.

## What's actually implemented

- **Adaptive workout engine** — the centerpiece. Deterministic substitution
  graph: remove the bench and "Dumbbell Bench Press" becomes "Floor Dumbbell
  Press"; remove all equipment and it becomes "Push-ups" — preserving
  muscle group, movement pattern, and approximate difficulty. See
  `backend/src/modules/exercises/substitutionEngine.ts` and its tests.
- **Progressive overload** — conservative weight suggestions based on
  logged history.
- **Nutrition engine** — Mifflin-St Jeor macro targets + diet/allergy/budget
  filtered meal plans. Deterministic, no LLM.
- **Food discovery** — provider abstraction that **never invents restaurant
  data**. Ships with a mock provider returning an honest empty state;
  swap in a real Google Places implementation via `MAPS_PROVIDER`.
- **AI abstraction layer** — the LLM is only used to phrase natural-language
  explanations on top of already-computed deterministic results (e.g. "why
  this exercise was swapped"). Ships with a zero-dependency template
  provider so the MVP runs with no API key.
- **Camera equipment detection** — point your camera at your gym corner,
  snap a photo, and it identifies known equipment (via a pluggable vision
  model) and suggests exercises + how-to instructions for exactly what it
  saw. See "Equipment vision" below.
- **Installable app (PWA)** — the frontend ships with a manifest, icons,
  and a service worker. "Add to Home Screen" on iOS/Android gives it a
  real app icon and a full-screen, no-browser-chrome window.
- **Vision Coach** — in-browser pose detection (MediaPipe Tasks Vision) with
  angle-based rep counting and live form feedback for Squat / Curl /
  Push-up, matching the reference UI.
- **Gym attendance** — QR scan (via camera + jsQR) or manual check-in,
  hard-capped at one entry per user per calendar day (enforced server-side).
- **Auth** — email/password with JWT access + refresh tokens.

## Why SQLite instead of Postgres

The schema (`backend/src/db/schema.sql`) is written in plain, portable SQL
against standard relational conventions (uuid keys, indexed foreign keys).
It runs on Node's built-in `node:sqlite` module here (Node 22.5+) so the
whole thing works with **zero
external services** — no DB server to stand up. Porting to Postgres is a
schema translation, not a redesign.

## Quickstart

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env
npm run migrate   # creates dev.db and all tables
npm run seed       # ~45 exercises + substitution graph + 21 foods
npm run dev         # starts on http://localhost:4000
```

Run the test suite (covers the substitution engine, macro calc, and
restaurant ranking):

```bash
npm test
```

### Deploying the backend

The root `render.yaml` deploys the backend to Render as an always-on web
service with a managed PostgreSQL database. Set `FRONTEND_ORIGIN` in Render to
the frontend URL. PostgreSQL migrations run as a pre-deploy step; normal server
starts do not run seed scripts. Configure SMTP and Upstash Redis secrets in
Render for OTP registration. The checked-in production database adapter is
PostgreSQL (and SQLite locally); no TiDB driver/migration exists in this repo.

### 2. Frontend

The frontend is a static, dependency-free HTML/JS app (no build step) so
you can open it directly or serve it with any static server:

```bash
cd frontend
python3 -m http.server 5173
# then open http://localhost:5173
```

If you're testing on a phone on the same Wi-Fi, edit `frontend/config.js`
and set `API_BASE` to your computer's LAN IP instead of `localhost`.

The Vision tab (pose detection) and Gym QR scan need camera permission and
an internet connection in the browser (they load the MediaPipe model and
jsQR from CDN at runtime) — everything else works fully offline against
your local backend.

### 3. Try the core flow

1. Register / log in
2. Complete onboarding, select **Dumbbells + Bench**
3. Go to Workout → generate a **Chest + Triceps** workout →
   you'll see Dumbbell Bench Press, Incline Dumbbell Press, Dumbbell Fly
4. Tap **"No equipment?"** on Dumbbell Bench Press → it swaps to
   **Floor Dumbbell Press** (or **Push-ups** if you remove all equipment
   from your profile first) — this is the deterministic substitution
   engine at work, not an LLM guess
5. Diet tab → generate today's plan → tap "Find this near me" on a meal
   (shows an honest "no live places provider connected" state, since no
   Google Places key is configured — see `.env.example`)
6. Vision tab → Start Camera → try a few squats; watch rep count + live
   form feedback
7. Gym tab → Mark manually or scan a QR code → try again → you'll get a
   clean "already checked in today" response

## API reference

See `backend/README.md` for the full endpoint list, or run the server and
hit `GET /health`.

## Equipment vision (camera → detected equipment → suggested exercises)

Ships defaulting to an honest "not configured" state — no API key means no
detection, never a fake one. To turn it on:

1. Sign up free at [roboflow.com](https://roboflow.com) (no credit card required)
2. Copy your API key from your workspace settings
3. In `backend/.env`, set:
   ```
   ROBOFLOW_API_KEY="your_key_here"
   ROBOFLOW_MODEL="lifttrack/4"
   ```
   `lifttrack/4` is a real public open-source model (detects barbell +
   dumbbell, 85% mAP@50). `dumbbell-detection/3` is a lighter single-class
   alternative. Browse more at
   [universe.roboflow.com](https://universe.roboflow.com/search?q=class%3Adumbbell).
4. Restart the backend. The "📷 Scan with camera" button in onboarding and
   "📷 Scan my equipment" on the Workout tab will now return real detections.

## Installing as an app (PWA)

The frontend is a installable Progressive Web App — no app-store build
needed:

- **Android (Chrome)**: open the site → menu (⋮) → "Add to Home screen" /
  "Install app"
- **iPhone (Safari)**: open the site → Share button → "Add to Home Screen"

Once installed it opens full-screen with its own icon, no browser address
bar. The app shell (HTML/CSS/JS) is cached by a service worker so it opens
instantly even on a flaky connection — the backend API calls, the MediaPipe
pose model, and jsQR still need a live connection since those aren't
meant to be cached (they're either dynamic or fetched fresh from CDN).

If you want a true native binary (`.apk`/`.ipa`) instead of a PWA, see the
**`mobile/`** folder — a full native Flutter app (same 5 screens, same
backend, real camera/pose-detection/QR packages) is included, with build
instructions in `mobile/README.md`.

## Native mobile app (Flutter)

`mobile/` contains a complete Flutter client — the same Today / Workout /
Diet / Vision / Gym screens as the web frontend, talking to the exact same
backend REST API, with real camera-based pose detection
(`google_mlkit_pose_detection`) and QR scanning (`mobile_scanner`) instead
of the browser-based equivalents.

**Important caveat:** this was written without a Flutter SDK available to
compile or run it — every non-trivial package API used was individually
verified against current documentation, but it has never actually been
built. See `mobile/README.md` for exact setup steps (including generating
the native Android/iOS project scaffolding via `flutter create`, since
those files are large and version-specific enough that hand-writing them
here would be riskier than letting your own Flutter install generate
them) and be prepared to fix a small thing on first `flutter run` — normal
for any first run, not a sign of a deeper problem.

## Architecture notes / what's intentionally scoped down

- **Native mobile app is untested.** `mobile/` (Flutter/Dart) was written
  without a Flutter SDK available to compile or run it in this
  environment — see the caveat above and `mobile/README.md`.
- **No live Postgres/production infra.** SQLite for zero-setup reproducibility;
  schema is Postgres-portable (see above).
- **Maps/Places and the LLM provider are both real abstractions with mock
  defaults**, not because they're incomplete stubs pretending to be done,
  but because wiring a real Google Places key or Anthropic/OpenAI key is a
  config change (`.env`), not a code change — see `src/maps/provider.ts`
  and `src/ai/provider.ts`.
