import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { db, nowIso } from "../../db/client";
import { requireAuth, AuthedRequest } from "../../common/auth";

export const gymRouter = Router();
gymRouter.use(requireAuth);

function todayDateStr(): string {
  // Local server date as YYYY-MM-DD (not full ISO) — this is the key the
  // one-per-day UNIQUE constraint is enforced against.
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

gymRouter.get("/today", async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const started = Date.now();
  const log = (label: string) => {
    if (process.env.NODE_ENV !== "production") console.info(`[gym/today] userId=${userId} ${label} ${Date.now() - started}ms`);
  };

  const row = await db.get<any>(`SELECT * FROM GymAttendance WHERE userId = ? AND date = ?`, req.userId!, todayDateStr());
  log("response ready");
  return res.json({ checkedIn: !!row, attendance: row ?? null });
});

const checkinSchema = z.object({
  method: z.enum(["qr", "manual"]),
});

gymRouter.post("/checkin", async (req: AuthedRequest, res) => {
  const parsed = checkinSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "method must be 'qr' or 'manual'" });

  const userId = req.userId!;
  const date = todayDateStr();

  const existing = await db.get(`SELECT * FROM GymAttendance WHERE userId = ? AND date = ?`, userId, date);
  if (existing) {
    return res.status(409).json({ error: "Already checked in today", attendance: existing });
  }

  const id = uuidv4();
  const ts = nowIso();
  try {
    await db.run(
      `INSERT INTO GymAttendance (id, userId, date, method, checkedInAt) VALUES (?, ?, ?, ?, ?)`,
      id,
      userId,
      date,
      parsed.data.method,
      ts
    );
  } catch (error: any) {
    if (error?.code === "23505") {
      const attendance = await db.get(`SELECT * FROM GymAttendance WHERE userId = ? AND date = ?`, userId, date);
      return res.status(409).json({ error: "Already checked in today", attendance });
    }
    throw error;
  }

  const row = await db.get(`SELECT * FROM GymAttendance WHERE id = ?`, id);
  return res.status(201).json({ attendance: row });
});

gymRouter.get("/history", async (req: AuthedRequest, res) => {
  const rows = await db.all(`SELECT * FROM GymAttendance WHERE userId = ? ORDER BY date DESC LIMIT 30`, req.userId!);
  return res.json(rows);
});
