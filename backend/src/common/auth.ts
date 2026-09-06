import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || "dev_access_secret_change_me";
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "dev_refresh_secret_change_me";

export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId }, ACCESS_SECRET, { expiresIn: "15m" });
}

export function signRefreshToken(userId: string): string {
  return jwt.sign({ sub: userId }, REFRESH_SECRET, { expiresIn: "30d" });
}

export function verifyRefreshToken(token: string): string {
  const decoded = jwt.verify(token, REFRESH_SECRET) as { sub: string };
  return decoded.sub;
}

export interface AuthedRequest extends Request {
  userId?: string;
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or malformed Authorization header" });
  }
  const token = header.slice("Bearer ".length);
  try {
    const decoded = jwt.verify(token, ACCESS_SECRET) as { sub: string };
    req.userId = decoded.sub;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired access token" });
  }
}
