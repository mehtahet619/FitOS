import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { createHmac, randomInt } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { db, nowIso } from "../../db/client";
import { AuthedRequest, clearSessionCookies, getRefreshCookie, hashRefreshSecret, isMobileClient, makeRefreshSecret, readIdentity, requireAuth, secureEqualHex, setSessionCookies, signAccessToken, signRefreshToken, verifyRefreshToken } from "../../common/auth";
import { emailService, getLocalVerificationCode } from "./emailService";
import { validateRegistrationEmail } from "./emailValidation";
import { logOtpFailure, logOtpStage } from "./otpDiagnostics";
import { getOtpLimiter, getOtpRedisConfigStatus } from "./tokenBucket";

export const authRouter = Router();
const OTP_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const OTP_SECRET = () => {
  const secret = process.env.OTP_HASH_SECRET;
  if (!secret && process.env.NODE_ENV === "production") throw new Error("OTP_HASH_SECRET is required in production");
  return secret || process.env.JWT_REFRESH_SECRET || "local_only_otp_secret_change_me";
};
const otpHash = (email: string, otp: string) => createHmac("sha256", OTP_SECRET()).update(`${email}:${otp}`).digest("hex");
const codeError = (res: Response, status: number, code: string, message: string) => res.status(status).json({ code, message });
const requestSchema = z.object({ email: z.string(), password: z.string().min(8).max(128), name: z.string().trim().min(1).max(120) });
const resendSchema = z.object({ email: z.string() });
const verifySchema = z.object({ email: z.string(), otp: z.string().regex(/^\d{6}$/) });
const resetSchema = z.object({ email: z.string(), otp: z.string().regex(/^\d{6}$/), password: z.string().min(8).max(128) });

authRouter.get("/dev/email-preview", (req, res) => {
  const remoteAddress = req.socket.remoteAddress || "";
  const isLoopback = remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
  if (process.env.NODE_ENV === "production" || process.env.ENABLE_LOCAL_EMAIL_PREVIEW !== "true" || !isLoopback) {
    return res.status(404).json({ error: "Not found" });
  }
  const email = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
  return res.json(getLocalVerificationCode(email) || { code: null });
});

async function allowOtpRequest(req: Request, res: Response, email: string, flow: string): Promise<boolean> {
  let result;
  logOtpStage("rate limiter check started", { flow });
  try { result = await getOtpLimiter().consumeRegistration(email, req.ip || "unknown"); }
  catch (error) {
    const config = getOtpRedisConfigStatus();
    const missingConfiguration = process.env.NODE_ENV === "production" && (!config.urlConfigured || !config.tokenConfigured);
    const operation = missingConfiguration ? "redis_configuration" : "redis_rate_limiter";
    console.error(missingConfiguration ? "[OTP] Redis configuration failed" : "[OTP] Redis rate limiter unavailable");
    logOtpFailure(operation, "upstash", error);
    res.status(503).json({ code: "OTP_SERVICE_UNAVAILABLE", message: "Verification is temporarily unavailable. Please try again later." });
    return false;
  }
  if (result.allowed) {
    logOtpStage("rate limiter check passed", { flow });
    return true;
  }
  res.setHeader("Retry-After", String(result.retryAfter));
  res.status(429).json({ code: "OTP_RATE_LIMITED", message: "Too many verification code requests. Please try again later.", retryAfter: result.retryAfter });
  return false;
}
function otpRateLimit(req: Request, res: Response, email: string, flow: string) {
  return allowOtpRequest(req, res, email, flow);
}
function transaction<T>(work: (tx: import("../../db/types").DatabaseLike) => Promise<T>): Promise<T> {
  if (!db.transaction) throw new Error("Database transaction support is required for authentication");
  return db.transaction(work);
}

async function sendRegistrationChallenge(email: string, name: string, passwordHash: string, userId: string | null) {
  let otp: string;
  let hashedOtp: string;
  try {
    otp = String(randomInt(100000, 1000000));
    hashedOtp = otpHash(email, otp);
  } catch (error) {
    logOtpFailure("otp_generation_or_hash", "node-crypto", error);
    throw error;
  }
  logOtpStage("OTP generated", { flow: "registration" });
  const now = nowIso();
  try {
    await db.run(`DELETE FROM PendingRegistration WHERE otpExpiresAt IS NOT NULL AND otpExpiresAt < ?`, now);
    await db.run(
      `INSERT INTO PendingRegistration (id,userId,email,name,passwordHash,otpHash,otpExpiresAt,otpAttempts,createdAt,updatedAt)
       VALUES (?,?,?,?,?,?,?,0,?,?) ON CONFLICT(email) DO UPDATE SET userId=excluded.userId,name=excluded.name,passwordHash=excluded.passwordHash,otpHash=excluded.otpHash,otpExpiresAt=excluded.otpExpiresAt,otpAttempts=0,updatedAt=excluded.updatedAt`,
      uuidv4(), userId, email, name, passwordHash, hashedOtp, new Date(Date.now() + OTP_MS).toISOString(), now, now
    );
    logOtpStage("OTP storage succeeded", { flow: "registration" });
  } catch (error) {
    logOtpFailure("otp_storage_registration", "database", error);
    throw error;
  }
  logOtpStage("email send started", { flow: "registration", provider: "nodemailer-smtp" });
  try {
    await emailService.sendVerificationOTP(name, email, otp);
    logOtpStage("email send succeeded", { flow: "registration", provider: "nodemailer-smtp" });
  } catch (error) {
    logOtpFailure("email_send_registration", "nodemailer-smtp", error);
    throw error;
  }
}

function sessionTokens(userId: string, sessionId: string) {
  const secretPart = makeRefreshSecret();
  return { accessToken: signAccessToken(userId, sessionId), refreshToken: signRefreshToken(userId, sessionId, secretPart), refreshHash: hashRefreshSecret(secretPart) };
}
async function createSession(userId: string, res: Response, req: Request) {
  const id = uuidv4(); const ts = nowIso(); const tokens = sessionTokens(userId, id);
  await db.run(`INSERT INTO AuthSession (id,userId,refreshTokenHash,expiresAt,revokedAt,createdAt,lastUsedAt) VALUES (?,?,?,?,NULL,?,?)`, id, userId, tokens.refreshHash, new Date(Date.now() + 30 * 86400000).toISOString(), ts, ts);
  if (isMobileClient(req)) return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
  setSessionCookies(res, tokens.accessToken, tokens.refreshToken);
  return undefined;
}
async function hasCompletedProfile(userId: string): Promise<boolean> {
  return Boolean(await db.get<{ id: string }>(`SELECT id FROM UserProfile WHERE userId=?`, userId));
}

// Legacy direct-registration endpoint cannot create an unverified account or session.
authRouter.post("/register", (_req, res) => codeError(res, 410, "OTP_REQUIRED", "Please register using email verification."));

authRouter.post("/register/request-otp", async (req, res) => {
  logOtpStage("request started", { flow: "registration" });
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) return codeError(res, 400, "INVALID_INPUT", "Please provide a name, valid email, and password of at least 8 characters.");
  const validated = await validateRegistrationEmail(parsed.data.email);
  if (!validated.valid) return codeError(res, 400, validated.code, validated.message);
  logOtpStage("email validation passed", { flow: "registration" });
  if (!await otpRateLimit(req, res, validated.email, "registration")) return res;
  const found = await db.get<{ id: string; email: string; name: string | null; passwordHash: string | null; emailVerified: number }>(`SELECT id,email,name,passwordHash,emailVerified FROM "User" WHERE LOWER(email)=?`, validated.email);
  if (found?.emailVerified) return res.status(409).json({ code: "ACCOUNT_EXISTS", message: "An account with this email already exists. Please sign in." });
  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  if (!found && await db.get(`SELECT id FROM "User" WHERE email=?`, validated.email)) return res.status(409).json({ code: "ACCOUNT_EXISTS", message: "An account with this email already exists. Please sign in." });
  try {
    await sendRegistrationChallenge(validated.email, parsed.data.name, passwordHash, found?.id ?? null);
  } catch {
    return codeError(res, 503, "OTP_SERVICE_UNAVAILABLE", "Verification is temporarily unavailable. Please try again later.");
  }
  return res.status(202).json({ message: "If this address can be registered, a verification code has been sent." });
});

authRouter.post("/register/resend-otp", async (req, res) => {
  logOtpStage("request started", { flow: "registration_resend" });
  const parsed = resendSchema.safeParse(req.body);
  if (!parsed.success) return codeError(res, 400, "INVALID_EMAIL", "Please enter a valid email address.");
  const validated = await validateRegistrationEmail(parsed.data.email);
  if (!validated.valid) return codeError(res, 400, validated.code, validated.message);
  logOtpStage("email validation passed", { flow: "registration_resend" });
  if (!await otpRateLimit(req, res, validated.email, "registration_resend")) return res;
  const pending = await db.get<{ email: string; name: string; passwordHash: string; userId: string | null }>(`SELECT * FROM PendingRegistration WHERE email=?`, validated.email);
  if (pending) {
    try { await sendRegistrationChallenge(pending.email, pending.name, pending.passwordHash, pending.userId); }
    catch {
      return codeError(res, 503, "OTP_SERVICE_UNAVAILABLE", "Verification is temporarily unavailable. Please try again later.");
    }
  }
  return res.status(202).json({ message: "If a verification is pending, a new code has been sent." });
});

async function verifyChallenge(email: string, submitted: string, table: "PendingRegistration" | "PasswordResetChallenge") {
  return transaction(async (tx) => {
    const row = await tx.get<{ id: string; userId?: string; email?: string; name?: string; passwordHash?: string; otpHash: string | null; otpExpiresAt: string | null; otpAttempts: number }>(
      table === "PendingRegistration" ? `SELECT * FROM PendingRegistration WHERE email=?` : `SELECT c.*,u.email,u.name FROM PasswordResetChallenge c JOIN "User" u ON u.id=c.userId WHERE u.email=?`, email
    );
    if (!row || !row.otpHash || !row.otpExpiresAt) return { ok: false as const, error: "OTP_INVALID" };
    if (new Date(row.otpExpiresAt).getTime() <= Date.now()) {
      await tx.run(`UPDATE ${table} SET otpHash=NULL,otpExpiresAt=NULL WHERE id=?`, row.id);
      return { ok: false as const, error: "OTP_EXPIRED" };
    }
    if (row.otpAttempts >= MAX_ATTEMPTS) return { ok: false as const, error: "OTP_ATTEMPTS_EXCEEDED" };
    const suppliedHash = otpHash(email, submitted);
    const valid = secureEqualHex(row.otpHash, suppliedHash);
    if (!valid) {
      const attempts = row.otpAttempts + 1;
      await tx.run(`UPDATE ${table} SET otpAttempts=?, otpHash=?, otpExpiresAt=? WHERE id=?`, attempts, attempts >= MAX_ATTEMPTS ? null : row.otpHash, attempts >= MAX_ATTEMPTS ? null : row.otpExpiresAt, row.id);
      return { ok: false as const, error: attempts >= MAX_ATTEMPTS ? "OTP_ATTEMPTS_EXCEEDED" : "OTP_INVALID" };
    }
    if (table === "PendingRegistration") await tx.run(`UPDATE PendingRegistration SET otpHash=NULL,otpExpiresAt=NULL,updatedAt=? WHERE id=?`, nowIso(), row.id);
    else await tx.run(`UPDATE PasswordResetChallenge SET otpHash=NULL,otpExpiresAt=NULL,updatedAt=? WHERE id=?`, nowIso(), row.id);
    return { ok: true as const, row };
  });
}

authRouter.post("/register/verify-otp", async (req, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) return codeError(res, 400, "OTP_INVALID", "Enter the 6-digit verification code.");
  const validation = await validateRegistrationEmail(parsed.data.email);
  if (!validation.valid) return codeError(res, 400, validation.code, validation.message);
  const checked = await verifyChallenge(validation.email, parsed.data.otp, "PendingRegistration");
  if (!checked.ok) {
    if (checked.error === "OTP_EXPIRED") return codeError(res, 400, "OTP_EXPIRED", "This verification code has expired. Please request a new code.");
    if (checked.error === "OTP_ATTEMPTS_EXCEEDED") return codeError(res, 429, checked.error, "Too many incorrect attempts. Please request a new code.");
    return codeError(res, 400, checked.error, "That verification code is not valid.");
  }
  const row = checked.row;
  if (!row.name || !row.passwordHash) return codeError(res, 400, "OTP_INVALID", "That verification code is not valid.");
  let userId = row.userId;
  const verifiedAt = nowIso();
  try {
    userId = await transaction(async (tx) => {
      const existing = await tx.get<{ id: string }>(`SELECT id FROM "User" WHERE LOWER(email)=?`, validation.email);
      const id = existing?.id ?? uuidv4();
      if (existing) await tx.run(`UPDATE "User" SET name=?,passwordHash=?,emailVerified=1,emailVerifiedAt=?,updatedAt=? WHERE id=?`, row.name, row.passwordHash, verifiedAt, verifiedAt, id);
      else await tx.run(`INSERT INTO "User" (id,email,passwordHash,googleId,name,emailVerified,emailVerifiedAt,createdAt,updatedAt) VALUES (?,?,?,NULL,?,1,?,?,?)`, id, validation.email, row.passwordHash, row.name, verifiedAt, verifiedAt, verifiedAt);
      await tx.run(`DELETE FROM PendingRegistration WHERE id=?`, row.id);
      return id;
    });
  } catch (error) {
    console.error("[AUTH] Verified account creation failed", error instanceof Error ? error.message : "unknown");
    return codeError(res, 409, "ACCOUNT_EXISTS", "This email address is already registered. Please sign in.");
  }
  const mobileTokens = await createSession(userId, res, req);
  const user = await db.get<{ id: string; name: string; email: string }>(`SELECT id,name,email FROM "User" WHERE id=?`, userId);
  return res.status(201).json({ authenticated: true, user: { ...user, emailVerified: true, profileComplete: await hasCompletedProfile(userId) }, ...(mobileTokens || {}) });
});

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1).max(128) });
authRouter.post("/login", async (req, res) => {
  const started = Date.now();
  const stage = (name: string) => { if (process.env.NODE_ENV !== "production") console.info(`[AUTH] ${name} ${Date.now() - started}ms`); };
  stage("login request started");
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return codeError(res, 400, "INVALID_INPUT", "Please enter a valid email and password.");
  const email = parsed.data.email.trim().toLowerCase();
  const user = await db.get<{ id: string; email: string; name: string | null; passwordHash: string | null; emailVerified: number }>(`SELECT id,email,name,passwordHash,emailVerified FROM "User" WHERE LOWER(email)=?`, email);
  stage("database lookup completed");
  if (!user || !user.passwordHash) return codeError(res, 401, "INVALID_CREDENTIALS", "Invalid email or password.");
  const valid = await bcrypt.compare(parsed.data.password, user.passwordHash);
  stage("password verification completed");
  if (!valid) return codeError(res, 401, "INVALID_CREDENTIALS", "Invalid email or password.");
  if (!user.emailVerified) return codeError(res, 403, "EMAIL_NOT_VERIFIED", "Please verify your email before signing in.");
  const mobileTokens = await createSession(user.id, res, req);
  stage("session created");
  const profileComplete = await hasCompletedProfile(user.id);
  const response = res.json({ authenticated: true, user: { id: user.id, name: user.name, email: user.email, emailVerified: true, profileComplete }, ...(mobileTokens || {}) });
  stage("login response sent");
  return response;
});

authRouter.get("/me", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const identity = await readIdentity(req);
  if (!identity) return res.json({ authenticated: false });
  const user = await db.get<{ id: string; name: string | null; email: string }>(`SELECT id,name,email FROM "User" WHERE id=?`, identity.userId);
  if (!user) return res.json({ authenticated: false });
  if (process.env.NODE_ENV !== "production") console.info("[AUTH] frontend session restored");
  return res.json({ authenticated: true, user: { ...user, emailVerified: true, profileComplete: await hasCompletedProfile(identity.userId) } });
});

authRouter.post("/refresh", async (req, res) => {
  const token = isMobileClient(req) ? req.body?.refreshToken : getRefreshCookie(req);
  if (!token) return codeError(res, 401, "SESSION_EXPIRED", "Your session has expired. Please sign in again.");
  try {
    const decoded = verifyRefreshToken(token);
    const session = await db.get<{ userId: string; refreshTokenHash: string }>(`SELECT userId,refreshTokenHash FROM AuthSession WHERE id=? AND userId=? AND revokedAt IS NULL AND expiresAt>?`, decoded.sessionId, decoded.userId, nowIso());
    if (!session || !secureEqualHex(session.refreshTokenHash, hashRefreshSecret(decoded.secretPart))) throw new Error("Invalid refresh session");
    const tokens = sessionTokens(decoded.userId, decoded.sessionId);
    const rotated = await db.run(`UPDATE AuthSession SET refreshTokenHash=?,lastUsedAt=? WHERE id=? AND refreshTokenHash=? AND revokedAt IS NULL`, tokens.refreshHash, nowIso(), decoded.sessionId, session.refreshTokenHash);
    if (rotated.changes !== 1) throw new Error("Session already rotated");
    if (isMobileClient(req)) return res.json({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
    setSessionCookies(res, tokens.accessToken, tokens.refreshToken);
    return res.json({ authenticated: true });
  } catch { if (!isMobileClient(req)) clearSessionCookies(res); return codeError(res, 401, "SESSION_EXPIRED", "Your session has expired. Please sign in again."); }
});

authRouter.post("/logout", requireAuth, async (req: AuthedRequest, res) => {
  await db.run(`UPDATE AuthSession SET revokedAt=? WHERE id=? AND userId=?`, nowIso(), req.sessionId, req.userId);
  clearSessionCookies(res);
  return res.json({ ok: true });
});

authRouter.post("/password/request-otp", async (req, res) => {
  logOtpStage("request started", { flow: "password_reset" });
  const parsed = resendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(202).json({ message: "If the account exists, a reset code has been sent." });
  const validated = await validateRegistrationEmail(parsed.data.email);
  if (!validated.valid) return res.status(202).json({ message: "If the account exists, a reset code has been sent." });
  logOtpStage("email validation passed", { flow: "password_reset" });
  let allowed: boolean;
  try {
    logOtpStage("rate limiter check started", { flow: "password_reset" });
    const result = await getOtpLimiter().consumeRegistration(`password:${validated.email}`, req.ip || "unknown");
    allowed = result.allowed;
    if (allowed) logOtpStage("rate limiter check passed", { flow: "password_reset" });
    if (!allowed) { res.setHeader("Retry-After", String(result.retryAfter)); return res.status(429).json({ code: "OTP_RATE_LIMITED", message: "Too many verification code requests. Please try again later.", retryAfter: result.retryAfter }); }
  } catch (error) {
    const config = getOtpRedisConfigStatus();
    const missingConfiguration = process.env.NODE_ENV === "production" && (!config.urlConfigured || !config.tokenConfigured);
    const operation = missingConfiguration ? "redis_configuration" : "redis_rate_limiter";
    console.error(missingConfiguration ? "[OTP] Redis configuration failed" : "[OTP] Redis rate limiter unavailable");
    logOtpFailure(operation, "upstash", error);
    return codeError(res, 503, "OTP_SERVICE_UNAVAILABLE", "Verification is temporarily unavailable. Please try again later.");
  }
  const user = await db.get<{ id: string; email: string; name: string | null }>(`SELECT id,email,name FROM "User" WHERE LOWER(email)=? AND emailVerified=1`, validated.email);
  if (user) {
    let otp: string;
    let hashedOtp: string;
    try {
      otp = String(randomInt(100000, 1000000));
      hashedOtp = otpHash(user.email, otp);
    } catch (error) {
      logOtpFailure("otp_generation_or_hash_password_reset", "node-crypto", error);
      return codeError(res, 503, "OTP_SERVICE_UNAVAILABLE", "Verification is temporarily unavailable. Please try again later.");
    }
    const ts = nowIso();
    logOtpStage("OTP generated", { flow: "password_reset" });
    try {
      const previous = await db.get<{ id: string }>(`SELECT id FROM PasswordResetChallenge WHERE userId=?`, user.id);
      if (previous) await db.run(`UPDATE PasswordResetChallenge SET otpHash=?,otpExpiresAt=?,otpAttempts=0,updatedAt=? WHERE id=?`, hashedOtp, new Date(Date.now() + OTP_MS).toISOString(), ts, previous.id);
      else await db.run(`INSERT INTO PasswordResetChallenge(id,userId,otpHash,otpExpiresAt,otpAttempts,createdAt,updatedAt) VALUES(?,?,?,?,0,?,?)`, uuidv4(), user.id, hashedOtp, new Date(Date.now() + OTP_MS).toISOString(), ts, ts);
      logOtpStage("OTP storage succeeded", { flow: "password_reset" });
    } catch (error) {
      logOtpFailure("otp_storage_password_reset", "database", error);
      return codeError(res, 503, "OTP_SERVICE_UNAVAILABLE", "Verification is temporarily unavailable. Please try again later.");
    }
    logOtpStage("email send started", { flow: "password_reset", provider: "nodemailer-smtp" });
    try {
      await emailService.sendPasswordResetOTP(user.name || "there", user.email, otp);
      logOtpStage("email send succeeded", { flow: "password_reset", provider: "nodemailer-smtp" });
    } catch (error) {
      logOtpFailure("email_send_password_reset", "nodemailer-smtp", error);
    }
  }
  return res.status(202).json({ message: "If the account exists, a reset code has been sent." });
});

authRouter.post("/password/reset", async (req, res) => {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) return codeError(res, 400, "INVALID_INPUT", "Enter your email, 6-digit code, and a password of at least 8 characters.");
  const validation = await validateRegistrationEmail(parsed.data.email);
  if (!validation.valid) return codeError(res, 400, validation.code, validation.message);
  const checked = await verifyChallenge(validation.email, parsed.data.otp, "PasswordResetChallenge");
  if (!checked.ok) return codeError(res, 400, checked.error, checked.error === "OTP_EXPIRED" ? "This verification code has expired. Please request a new code." : "That reset code is not valid.");
  const passwordHash = await bcrypt.hash(parsed.data.password, 12); const ts = nowIso();
  await transaction(async (tx) => {
    await tx.run(`UPDATE "User" SET passwordHash=?,updatedAt=? WHERE id=?`, passwordHash, ts, checked.row.userId);
    await tx.run(`UPDATE AuthSession SET revokedAt=? WHERE userId=? AND revokedAt IS NULL`, ts, checked.row.userId);
    await tx.run(`DELETE FROM PasswordResetChallenge WHERE userId=?`, checked.row.userId);
  });
  return res.json({ message: "Password reset. Please sign in with your new password." });
});

authRouter.post("/google", (_req, res) => res.status(501).json({ error: "Google login not configured in this MVP" }));
