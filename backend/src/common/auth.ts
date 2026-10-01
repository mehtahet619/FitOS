import jwt from "jsonwebtoken";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { Request, Response, NextFunction } from "express";
import { db } from "../db/client";

const accessSecret = () => {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret && process.env.NODE_ENV === "production") throw new Error("JWT_ACCESS_SECRET is required in production");
  return secret || "local_only_access_secret_change_me";
};
const refreshSecret = () => {
  const secret = process.env.JWT_REFRESH_SECRET;
  if (!secret && process.env.NODE_ENV === "production") throw new Error("JWT_REFRESH_SECRET is required in production");
  return secret || "local_only_refresh_secret_change_me";
};
export const SESSION_COOKIE_ACCESS = "fitos_access";
export const SESSION_COOKIE_REFRESH = "fitos_refresh";

export function signAccessToken(userId: string, sessionId: string): string {
  return jwt.sign({ sub: userId, sid: sessionId }, accessSecret(), { expiresIn: "15m" });
}
export function signRefreshToken(userId: string, sessionId: string, secretPart: string): string {
  return jwt.sign({ sub: userId, sid: sessionId, secretPart }, refreshSecret(), { expiresIn: "30d" });
}
export function verifyRefreshToken(token: string): { userId: string; sessionId: string; secretPart: string } {
  const decoded = jwt.verify(token, refreshSecret()) as { sub: string; sid: string; secretPart: string };
  if (!decoded.sid || !decoded.secretPart) throw new Error("Invalid refresh token");
  return { userId: decoded.sub, sessionId: decoded.sid, secretPart: decoded.secretPart };
}
export function hashRefreshSecret(secretPart: string): string {
  const secret = process.env.JWT_REFRESH_SECRET || "local_only_refresh_secret_change_me";
  return createHash("sha256").update(`${secret}:${secretPart}`).digest("hex");
}
export function secureEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
export function makeRefreshSecret(): string { return randomBytes(32).toString("base64url"); }

function sessionCookieOptions() {
  const production = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: production,
    // The Render web and API services are different sites. Lax cookies are
    // omitted by credentialed cross-site fetches, including /auth/refresh.
    sameSite: production ? "none" as const : "lax" as const,
    // Partitioned cookies remain available to the FitOS top-level site in
    // browsers that block unpartitioned third-party cookies.
    ...(production ? { partitioned: true } : {}),
    path: "/" as const,
  };
}

export interface AuthedRequest extends Request { userId?: string; sessionId?: string; }
function cookieValue(req: Request, name: string): string | undefined {
  const cookie = req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : undefined;
}
export function getAccessToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : cookieValue(req, SESSION_COOKIE_ACCESS);
}
export function getRefreshCookie(req: Request): string | undefined {
  return cookieValue(req, SESSION_COOKIE_REFRESH);
}
export function setSessionCookies(res: Response, accessToken: string, refreshToken: string): void {
  const options = sessionCookieOptions();
  res.cookie(SESSION_COOKIE_ACCESS, accessToken, { ...options, maxAge: 15 * 60 * 1000 });
  res.cookie(SESSION_COOKIE_REFRESH, refreshToken, { ...options, maxAge: 30 * 24 * 60 * 60 * 1000 });
}
export function clearSessionCookies(res: Response): void {
  const options = sessionCookieOptions();
  res.clearCookie(SESSION_COOKIE_ACCESS, options); res.clearCookie(SESSION_COOKIE_REFRESH, options);
}
export function isMobileClient(req: Request): boolean { return req.header("X-FitOS-Client") === "mobile"; }

async function resolveIdentity(req: Request): Promise<{ userId: string; sessionId: string } | undefined> {
  const token = getAccessToken(req);
  if (!token) return undefined;
  const decoded = jwt.verify(token, accessSecret()) as { sub: string; sid: string };
  if (!decoded.sub || !decoded.sid) return undefined;
  const session = await db.get<{ id: string; userId: string }>(
    `SELECT s.id, s.userId FROM AuthSession s JOIN "User" u ON u.id=s.userId WHERE s.id=? AND s.userId=? AND s.revokedAt IS NULL AND s.expiresAt>? AND u.emailVerified=1`,
    decoded.sid, decoded.sub, new Date().toISOString()
  );
  return session ? { userId: session.userId, sessionId: session.id } : undefined;
}
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const routePath = `${req.baseUrl}${req.path}`;
  const trace = ["/progress/dashboard", "/user/profile", "/workouts/plan", "/nutrition/today", "/gym/today"].includes(routePath);
  const startedAt = Date.now();
  if (trace) console.info(`[TRACE] ${req.method} ${routePath}:auth:start`);
  try {
    const identity = await resolveIdentity(req);
    if (trace) console.info(`[TRACE] ${req.method} ${routePath}:auth:end durationMs=${Date.now() - startedAt}`);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    req.userId = identity.userId; req.sessionId = identity.sessionId;
    next();
  } catch {
    if (trace) console.warn(`[TRACE] ${req.method} ${routePath}:auth:error durationMs=${Date.now() - startedAt}`);
    return res.status(401).json({ error: "Unauthorized" });
  }
}
export async function readIdentity(req: Request) {
  try { return await resolveIdentity(req); } catch { return undefined; }
}
