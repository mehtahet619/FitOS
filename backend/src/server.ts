import "dotenv/config";
import "express-async-errors";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

import { authRouter } from "./modules/auth/routes";
import { userRouter } from "./modules/user/routes";
import { equipmentRouter } from "./modules/equipment/routes";
import { exerciseRouter } from "./modules/exercises/routes";
import { workoutRouter } from "./modules/workouts/routes";
import { nutritionRouter } from "./modules/nutrition/routes";
import { foodRouter } from "./modules/food/routes";
import { foodScannerRouter } from "./modules/nutrition/foodScanner";
import { progressRouter } from "./modules/progress/routes";
import { musclesRouter } from "./modules/muscles/routes";
import { gymRouter } from "./modules/gym/routes";
import { growImpactRouter } from "./modules/grow-impact/routes";
import { comparisonRouter, COMPARISON_BODY_LIMIT } from "./modules/comparison/routes";
import { coachRouter } from "./modules/coach/routes";
import { logOtpRuntimeDiagnostics } from "./modules/auth/otpRuntimeDiagnostics";
import { initializeEquipmentVisionProvider } from "./vision/equipmentVisionProvider";
import { AuthedRequest, readIdentity, requireAuth } from "./common/auth";
import { db } from "./db/client";

const app = express();
app.set("trust proxy", 1);
const tracedApiPaths = new Set([
  "/auth/login", "/auth/me", "/auth/refresh",
  "/progress/dashboard", "/user/profile", "/workouts/plan",
  "/nutrition/today", "/gym/today",
]);
app.use((req, res, next) => {
  if (!tracedApiPaths.has(req.path)) return next();
  const startedAt = Date.now();
  const route = `${req.method} ${req.path}`;
  console.info(`[HTTP] ${route} start`);
  res.once("finish", () => {
    console.info(`[HTTP] ${route} status=${res.statusCode} durationMs=${Date.now() - startedAt}`);
  });
  res.once("close", () => {
    if (!res.writableFinished) {
      console.warn(`[HTTP] ${route} client_closed durationMs=${Date.now() - startedAt}`);
    }
  });
  next();
});
const allowedFrontendOrigins = new Set(
  (process.env.FRONTEND_ORIGIN || (process.env.NODE_ENV === "production" ? "" : "http://localhost:5173"))
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean)
);
function isAllowedFrontendOrigin(origin: string): boolean {
  const normalized = origin.replace(/\/$/, "");
  if (allowedFrontendOrigins.has(normalized)) return true;
  // Render preview deploys use unique subdomains. Trust only the configured
  // static-site service, not every arbitrary *.onrender.com origin.
  if (!allowedRenderServiceId) return false;
  try {
    const parsedOrigin = new URL(origin);
    const previewHostPrefix = `${allowedRenderServiceId.toLowerCase()}-`;
    return parsedOrigin.protocol === "https:" &&
      parsedOrigin.hostname.toLowerCase().startsWith(previewHostPrefix) &&
      parsedOrigin.hostname.toLowerCase().endsWith(".onrender.com");
  } catch {
    return false;
  }
}
const allowedRenderServiceId = process.env.RENDER_SERVICE_ID;
if (process.env.NODE_ENV === "production") {
  if (!process.env.JWT_ACCESS_SECRET || !process.env.JWT_REFRESH_SECRET) {
    throw new Error("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET are required in production");
  }
  if (allowedFrontendOrigins.size === 0 || [...allowedFrontendOrigins].some((origin) => {
    try {
      const parsed = new URL(origin);
      return parsed.protocol !== "https:" || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    } catch { return true; }
  })) {
    throw new Error("FRONTEND_ORIGIN must contain the production HTTPS frontend origin(s)");
  }
}
app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      if (!origin || isAllowedFrontendOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
  })
);
function applySecurityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader("Cache-Control", "no-store");
  const origin = req.header("Origin");
  const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
  if (origin && mutating && req.headers.cookie && !isAllowedFrontendOrigin(origin)) {
    return res.status(403).json({ code: "CSRF_ORIGIN_REJECTED", error: "Request origin is not allowed" });
  }
  next();
}

const limiter = rateLimit({ windowMs: 60 * 1000, max: 120 });

// Pose sequences submitted for form comparison exceed the default 100kb JSON
// limit, so this router parses its own bounded body. It is mounted ahead of the
// global parser — which would otherwise reject the payload first — and
// re-applies the same security headers, CSRF check, and rate limit that every
// other route gets.
app.use(
  "/comparison",
  limiter,
  applySecurityHeaders,
  express.json({ limit: COMPARISON_BODY_LIMIT }),
  comparisonRouter
);
app.use("/coach", limiter, applySecurityHeaders, express.json({ limit: "4mb" }), coachRouter);
app.use("/api/coach", limiter, applySecurityHeaders, express.json({ limit: "4mb" }), coachRouter);
app.use(express.json({ limit: "4mb" }));
app.use(applySecurityHeaders);
app.use(limiter);

// Price guesses are persisted in the shared database so all visitors and backend
// instances see the same total. The unique userId key guarantees one guess per account.
async function getPriceGuessSummary(userId?: string) {
  const aggregate = await db.get<{ average: number | string | null; count: number | string }>(
    "SELECT AVG(price) AS average, COUNT(*) AS count FROM PricingGuess"
  );
  const ownGuess = userId
    ? await db.get<{ price: number }>("SELECT price FROM PricingGuess WHERE userId = ?", userId)
    : undefined;
  const count = Number(aggregate?.count ?? 0);
  const averageValue = aggregate?.average == null ? null : Number(aggregate.average);
  return {
    average: Number.isFinite(averageValue) ? averageValue : null,
    count: Number.isSafeInteger(count) ? count : 0,
    hasGuessed: Boolean(ownGuess),
    userGuess: ownGuess ? Number(ownGuess.price) : null,
  };
}

app.get("/pricing-guesses", async (req, res) => {
  const identity = await readIdentity(req);
  res.setHeader("Cache-Control", "no-store");
  res.json({ ...(await getPriceGuessSummary(identity?.userId)), authenticated: Boolean(identity?.userId) });
});

app.post("/pricing-guesses", requireAuth, async (req: AuthedRequest, res) => {
  const price = req.body?.price;
  if (!Number.isSafeInteger(price) || price < 1 || price > 100000) {
    return res.status(400).json({ error: "Enter a whole price between ₹1 and ₹1,00,000." });
  }
  if (!req.userId) return res.status(401).json({ error: "Log in to submit your one price guess." });

  try {
    await db.run(
      "INSERT INTO PricingGuess (userId, price, createdAt) VALUES (?, ?, ?)",
      req.userId,
      price,
      new Date().toISOString()
    );
  } catch (error) {
    // The primary key is userId. A concurrent duplicate request can never count twice.
    const existing = await db.get<{ price: number }>(
      "SELECT price FROM PricingGuess WHERE userId = ?",
      req.userId
    );
    if (existing) {
      return res.status(409).json({
        error: "You've already submitted your guess. Each account gets one guess.",
        ...(await getPriceGuessSummary(req.userId)),
      });
    }
    throw error;
  }

  return res.status(201).json(await getPriceGuessSummary(req.userId));
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Readiness endpoint for uptime monitors. It distinguishes a running API from
// an API whose shared database is unavailable without exposing connection data.
app.get("/health/ready", async (_req, res) => {
  try {
    await db.get<{ ok: number }>("SELECT 1 AS ok");
    return res.json({ status: "ready", database: "ok" });
  } catch {
    return res.status(503).json({ status: "not_ready", database: "unavailable" });
  }
});

app.use("/auth", authRouter);
app.use("/api/auth", authRouter);
app.use("/user", userRouter);
app.use("/equipment", equipmentRouter);
app.use("/", equipmentRouter); // exposes /user/equipment alongside /equipment
app.use("/exercises", exerciseRouter);
app.use("/workouts", workoutRouter);
app.use("/nutrition", nutritionRouter);
app.use("/food", foodRouter);
app.use("/food-scanner", foodScannerRouter);
app.use("/progress", progressRouter);
app.use("/muscles", musclesRouter);
app.use("/gym", gymRouter);
app.use("/grow-impact", growImpactRouter);

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
});

// Central error handler — every route above should be using try/catch or
// async errors that fall through to here rather than crashing the process.
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Adaptive Fit API listening on :${PORT}`);
  void initializeEquipmentVisionProvider().catch((error) => console.error(`[CV] Model failed to load: ${error.message}`));
  void logOtpRuntimeDiagnostics();
});
