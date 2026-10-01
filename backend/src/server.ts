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
import { progressRouter } from "./modules/progress/routes";
import { musclesRouter } from "./modules/muscles/routes";
import { gymRouter } from "./modules/gym/routes";
import { logOtpRuntimeDiagnostics } from "./modules/auth/otpRuntimeDiagnostics";

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
  (process.env.FRONTEND_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean)
);
const allowedRenderServiceId = process.env.RENDER_SERVICE_ID;
app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      if (!origin || allowedFrontendOrigins.has(origin.replace(/\/$/, ""))) {
        callback(null, true);
        return;
      }
      // Render preview deploys use unique subdomains. Trust only the configured
      // static-site service, not every arbitrary *.onrender.com origin.
      if (allowedRenderServiceId) {
        try {
          const parsedOrigin = new URL(origin);
          const previewHostPrefix = `${allowedRenderServiceId.toLowerCase()}-`;
          if (
            parsedOrigin.protocol === "https:" &&
            parsedOrigin.hostname.toLowerCase().startsWith(previewHostPrefix) &&
            parsedOrigin.hostname.toLowerCase().endsWith(".onrender.com")
          ) {
            callback(null, true);
            return;
          }
        } catch {
          // Invalid Origin headers are rejected below.
        }
      }
      callback(null, false);
    },
  })
);
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  const origin = req.header("Origin");
  const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
  if (origin && mutating && req.headers.cookie && !allowedFrontendOrigins.has(origin.replace(/\/$/, ""))) {
    return res.status(403).json({ code: "CSRF_ORIGIN_REJECTED", error: "Request origin is not allowed" });
  }
  next();
});

const limiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
app.use(limiter);

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/auth", authRouter);
app.use("/api/auth", authRouter);
app.use("/user", userRouter);
app.use("/equipment", equipmentRouter);
app.use("/", equipmentRouter); // exposes /user/equipment alongside /equipment
app.use("/exercises", exerciseRouter);
app.use("/workouts", workoutRouter);
app.use("/nutrition", nutritionRouter);
app.use("/food", foodRouter);
app.use("/progress", progressRouter);
app.use("/muscles", musclesRouter);
app.use("/gym", gymRouter);

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
  void logOtpRuntimeDiagnostics();
});
