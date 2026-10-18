import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { db, nowIso } from "../../db/client";
import { AuthedRequest, requireAuth } from "../../common/auth";

export const foodScannerRouter = Router();
foodScannerRouter.use(requireAuth);

let tableReady: Promise<void> | undefined;
function ensureFoodLogTable(): Promise<void> {
  if (!tableReady) {
    tableReady = db.exec(`
      CREATE TABLE IF NOT EXISTS FoodLog (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL REFERENCES User(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        brand TEXT,
        barcode TEXT,
        servingGrams REAL NOT NULL,
        calories REAL,
        proteinG REAL,
        carbsG REAL,
        fatG REAL,
        fiberG REAL,
        sugarG REAL,
        sodiumMg REAL,
        source TEXT NOT NULL,
        sourceUrl TEXT,
        verificationStatus TEXT NOT NULL DEFAULT 'user_confirmed',
        loggedAt TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `).then(() => db.exec("CREATE INDEX IF NOT EXISTS idx_foodlog_user_logged ON FoodLog(userId, loggedAt)"));
  }
  return tableReady;
}

const OFF_FIELDS = "code,product_name,product_name_en,brands,quantity,serving_size,nutriments,image_front_small_url,ecoscore_grade,nutriscore_grade";
const numeric = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
function per100(product: any) {
  const n = product?.nutriments || {};
  return {
    calories: numeric(n["energy-kcal_100g"]) ?? (numeric(n.energy_100g) === null ? null : Math.round(Number(n.energy_100g) / 4.184 * 10) / 10),
    proteinG: numeric(n.proteins_100g),
    carbsG: numeric(n.carbohydrates_100g),
    fatG: numeric(n.fat_100g),
    fiberG: numeric(n.fiber_100g),
    sugarG: numeric(n.sugars_100g),
    sodiumMg: numeric(n.sodium_100g) === null ? null : Math.round(Number(n.sodium_100g) * 1000),
  };
}

foodScannerRouter.get("/product/:barcode", async (req, res) => {
  const barcode = String(req.params.barcode || "").trim();
  if (!/^\d{8,14}$/.test(barcode)) return res.status(400).json({ error: "Enter a valid 8–14 digit EAN/UPC barcode." });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(`https://world.openfoodfacts.org/api/v2/product/${barcode}.json?fields=${OFF_FIELDS}`, {
      headers: { "User-Agent": "FitOS/1.0 (food scanner; contact: support@fitos.app)" },
      signal: controller.signal,
    });
    if (!response.ok) return res.status(502).json({ error: "Open Food Facts is temporarily unavailable. Try manual entry." });
    const data: any = await response.json();
    if (data.status !== 1 || !data.product) return res.status(404).json({ found: false, barcode, source: "Open Food Facts", message: "Product not found. You can enter nutrition from the package label manually." });
    const p = data.product;
    return res.json({
      found: true, barcode, name: String(p.product_name || p.product_name_en || "").trim(),
      brand: String(p.brands || "").trim(), packageQuantity: p.quantity || null,
      servingSize: p.serving_size || null, imageUrl: p.image_front_small_url || null,
      nutrientsPer100g: per100(p), source: "Open Food Facts",
      sourceUrl: `https://world.openfoodfacts.org/product/${barcode}`,
      nutritionCompleteness: ["calories","proteinG","carbsG","fatG"].filter((k) => (per100(p) as any)[k] !== null).length,
      verificationStatus: "third_party_database_unverified",
      note: "Community-contributed product data. Check the package label and confirm serving size before logging.",
    });
  } catch (error: any) {
    const timeoutError = error?.name === "AbortError";
    return res.status(timeoutError ? 504 : 502).json({ error: timeoutError ? "Open Food Facts lookup timed out. Try again or enter details manually." : "Could not reach Open Food Facts. Try manual entry." });
  } finally { clearTimeout(timeout); }
});

foodScannerRouter.get("/logs/today", async (req: AuthedRequest, res) => {
  await ensureFoodLogTable();
  const userId = req.userId!;
  const day = String(req.query.date || new Date().toISOString().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: "Date must be YYYY-MM-DD." });
  const logs = await db.all<any>("SELECT * FROM FoodLog WHERE userId = ? AND substr(loggedAt,1,10) = ? ORDER BY loggedAt DESC", userId, day);
  const total = logs.reduce((sum, row) => {
    const factor = Number(row.servingGrams || 0) / 100;
    for (const key of ["calories","proteinG","carbsG","fatG","fiberG","sugarG"]) sum[key] += row[key] == null ? 0 : Number(row[key]) * factor;
    return sum;
  }, { calories: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0, sugarG: 0 });
  return res.json({ date: day, logs, totals: Object.fromEntries(Object.entries(total).map(([k,v]) => [k, Math.round(v*10)/10])) });
});

foodScannerRouter.post("/logs", async (req: AuthedRequest, res) => {
  await ensureFoodLogTable();
  const b = req.body || {};
  const name = String(b.name || "").trim().slice(0, 160);
  const servingGrams = Number(b.servingGrams);
  if (!name || !Number.isFinite(servingGrams) || servingGrams <= 0 || servingGrams > 5000) return res.status(400).json({ error: "Food name and a serving between 0 and 5000 grams are required." });
  const nutrients: Record<string, number | null> = {};
  for (const key of ["calories","proteinG","carbsG","fatG","fiberG","sugarG","sodiumMg"]) {
    const value = b[key] === "" || b[key] === undefined || b[key] === null ? null : Number(b[key]);
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 100000)) return res.status(400).json({ error: `Invalid nutrient value: ${key}` });
    nutrients[key] = value;
  }
  const barcode = b.barcode && /^\d{8,14}$/.test(String(b.barcode)) ? String(b.barcode) : null;
  // Protect against a double tap/retry creating duplicate barcode logs in the same minute.
  if (barcode) {
    const duplicate = await db.get<any>("SELECT id FROM FoodLog WHERE userId = ? AND barcode = ? AND loggedAt >= ?", req.userId!, barcode, new Date(Date.now()-60_000).toISOString());
    if (duplicate) return res.status(409).json({ error: "This barcode was just logged. Refresh today's diary before adding it again.", duplicate: true });
  }
  const id = uuidv4(); const now = nowIso();
  await db.run(`INSERT INTO FoodLog (id,userId,name,brand,barcode,servingGrams,calories,proteinG,carbsG,fatG,fiberG,sugarG,sodiumMg,source,sourceUrl,verificationStatus,loggedAt,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, req.userId!, name, String(b.brand || "").slice(0,160) || null, barcode, servingGrams,
    nutrients.calories, nutrients.proteinG, nutrients.carbsG, nutrients.fatG, nutrients.fiberG, nutrients.sugarG, nutrients.sodiumMg,
    String(b.source || "manual").slice(0,80), typeof b.sourceUrl === "string" && /^https:\/\/world\.openfoodfacts\.org\/product\/\d+$/.test(b.sourceUrl) ? b.sourceUrl : null,
    String(b.verificationStatus || "user_confirmed").slice(0,80), now, now, now);
  const saved = await db.get<any>("SELECT * FROM FoodLog WHERE id = ? AND userId = ?", id, req.userId!);
  return res.status(201).json(saved);
});

foodScannerRouter.patch("/logs/:id", async (req: AuthedRequest, res) => {
  await ensureFoodLogTable();
  const current = await db.get<any>("SELECT * FROM FoodLog WHERE id = ? AND userId = ?", String(req.params.id), req.userId!);
  if (!current) return res.status(404).json({ error: "Food log not found." });
  const b = req.body || {};
  const servingGrams = b.servingGrams === undefined ? Number(current.servingGrams) : Number(b.servingGrams);
  if (!Number.isFinite(servingGrams) || servingGrams <= 0 || servingGrams > 5000) return res.status(400).json({ error: "Serving must be between 0 and 5000 grams." });
  const allowed = ["name","brand","calories","proteinG","carbsG","fatG","fiberG","sugarG","sodiumMg"] as const;
  const values: any = { servingGrams, updatedAt: nowIso() };
  for (const key of allowed) if (b[key] !== undefined) values[key] = key === "name" || key === "brand" ? String(b[key]).slice(0,160) : (b[key] === null || b[key] === "" ? null : Number(b[key]));
  for (const key of ["calories","proteinG","carbsG","fatG","fiberG","sugarG","sodiumMg"]) if (values[key] !== undefined && values[key] !== null && (!Number.isFinite(values[key]) || values[key] < 0)) return res.status(400).json({ error: `Invalid nutrient value: ${key}` });
  const columns = Object.keys(values);
  await db.run(`UPDATE FoodLog SET ${columns.map((key) => `${key} = ?`).join(",")} WHERE id = ? AND userId = ?`, ...columns.map((key) => values[key]), String(req.params.id), req.userId!);
  return res.json(await db.get<any>("SELECT * FROM FoodLog WHERE id = ? AND userId = ?", String(req.params.id), req.userId!));
});

foodScannerRouter.delete("/logs/:id", async (req: AuthedRequest, res) => {
  await ensureFoodLogTable();
  const result = await db.run("DELETE FROM FoodLog WHERE id = ? AND userId = ?", String(req.params.id), req.userId!);
  return result.changes ? res.status(204).end() : res.status(404).json({ error: "Food log not found." });
});
