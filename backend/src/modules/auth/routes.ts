import { Router } from "express";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { db, nowIso } from "../../db/client";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../../common/auth";

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

authRouter.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }
  const { email, password } = parsed.data;

  const existing = await db.get(`SELECT id FROM "User" WHERE email = ?`, email);
  if (existing) return res.status(409).json({ error: "Email already registered" });

  const passwordHash = bcrypt.hashSync(password, 10);
  const id = uuidv4();
  const ts = nowIso();
  await db.run(
    `INSERT INTO "User" (id, email, passwordHash, googleId, createdAt, updatedAt) VALUES (?, ?, ?, NULL, ?, ?)`,
    id,
    email,
    passwordHash,
    ts,
    ts
  );

  return res.status(201).json({
    user: { id, email },
    accessToken: signAccessToken(id),
    refreshToken: signRefreshToken(id),
  });
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
  const { email, password } = parsed.data;

  const user = await db.get<{ id: string; email: string; passwordHash: string | null }>(
    `SELECT * FROM "User" WHERE email = ?`,
    email
  );
  if (!user || !user.passwordHash) return res.status(401).json({ error: "Invalid credentials" });

  const valid = bcrypt.compareSync(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: "Invalid credentials" });

  return res.json({
    user: { id: user.id, email: user.email },
    accessToken: signAccessToken(user.id),
    refreshToken: signRefreshToken(user.id),
  });
});

authRouter.post("/refresh", (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: "refreshToken required" });
  try {
    const userId = verifyRefreshToken(refreshToken);
    return res.json({ accessToken: signAccessToken(userId) });
  } catch {
    return res.status(401).json({ error: "Invalid or expired refresh token" });
  }
});

// Google login stub: accepts a verified Google ID token in production via
// google-auth-library; wired here as a clearly-marked stub so the endpoint
// shape is correct without requiring a Google OAuth client for the MVP to run.
authRouter.post("/google", (_req, res) => {
  return res.status(501).json({
    error: "Google login not configured in this MVP",
    note: "Wire up google-auth-library ticket verification here; endpoint shape is ready.",
  });
});
