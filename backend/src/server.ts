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

const app = express();
app.set("trust proxy", 1);
app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN || true,
  })
);
app.use(express.json());

const limiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
app.use(limiter);

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/auth", authRouter);
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
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Adaptive Fit API listening on :${PORT}`);
});
