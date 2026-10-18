// Must be the first import in a test: it points the (module-singleton) DB and Open Food Facts client at test fixtures.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const dbFile = path.join(os.tmpdir(), `fitos-food-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.JWT_ACCESS_SECRET = "test_access_secret";
process.env.OPENFOODFACTS_TIMEOUT_MS = "400";

export type OffReply = { status?: number; body?: unknown; raw?: string; delayMs?: number };
export type OffHandler = (url: URL, call: number) => OffReply;

export async function startHarness() {
  // Fake Open Food Facts.
  const offCalls: string[] = [];
  let offHandler: OffHandler = () => ({ status: 404, body: { status: 0 } });
  const off = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://off.local");
    offCalls.push(url.pathname);
    const reply = offHandler(url, offCalls.length);
    setTimeout(() => {
      res.statusCode = reply.status ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(reply.raw !== undefined ? reply.raw : JSON.stringify(reply.body ?? {}));
    }, reply.delayMs ?? 0);
  });
  await new Promise<void>((r) => off.listen(0, "127.0.0.1", r));
  const offPort = (off.address() as AddressInfo).port;
  process.env.OPENFOODFACTS_BASE_URL = `http://127.0.0.1:${offPort}`;
  process.env.OPENFOODFACTS_SEARCH_URL = `http://127.0.0.1:${offPort}/search`;

  // Dynamic imports (with .js, like the other tests) so the env vars above are set before the DB singleton loads.
  const { db } = await import("../../db/client.js");
  await db.exec(fs.readFileSync(path.join(__dirname, "../../db/schema.sql"), "utf8"));
  const express = (await import("express")).default;
  const { foodScannerRouter } = await import("../../modules/food-scanner/routes.js");
  const { signAccessToken } = await import("../../common/auth.js");

  const app = express();
  app.use(express.json());
  app.use("/nutrition", foodScannerRouter);
  app.use((_req, res) => res.status(404).json({ error: "No route" }));
  const api = http.createServer(app);
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  const apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  async function makeUser(label: string) {
    const now = new Date().toISOString();
    const userId = `user-${label}-${Math.random().toString(36).slice(2)}`;
    const sessionId = `sess-${label}-${Math.random().toString(36).slice(2)}`;
    await db.run("INSERT INTO User (id,email,emailVerified,createdAt,updatedAt) VALUES (?,?,1,?,?)", userId, `${userId}@example.test`, now, now);
    await db.run("INSERT INTO AuthSession (id,userId,refreshTokenHash,expiresAt,createdAt,lastUsedAt) VALUES (?,?,?,?,?,?)", sessionId, userId, "x", new Date(Date.now() + 86400000).toISOString(), now, now);
    return { userId, token: signAccessToken(userId, sessionId) };
  }
  return {
    db, apiBase, offCalls, makeUser,
    setOff(handler: OffHandler) { offCalls.length = 0; offHandler = handler; },
    async close() { await new Promise((r) => api.close(r)); await new Promise((r) => off.close(r)); fs.rmSync(dbFile, { force: true }); },
  };
}

export const NUTELLA = {
  status: 1,
  product: {
    code: "3017620422003", product_name: "Nutella", brands: "Ferrero", quantity: "400 g", serving_size: "15 g", serving_quantity: 15,
    nutriments: { "energy-kcal_100g": 539, proteins_100g: 6.3, carbohydrates_100g: 57.5, fat_100g: 30.9, fiber_100g: 0, sodium_100g: 0.0428, "energy-kcal_serving": 80.9, proteins_serving: 0.9 },
  },
};
