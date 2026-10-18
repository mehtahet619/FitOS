import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { db, nowIso } from "../../db/client";
import { AuthedRequest, requireAuth } from "../../common/auth";

export const foodScannerRouter = Router();
foodScannerRouter.use(requireAuth);

const numberOrNull = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
};

foodScannerRouter.get("/product/:barcode", async (req, res) => {
  const barcode = String(req.params.barcode || "").trim();
  if (!/^\d{8,14}$/.test(barcode)) return res.status(400).json({ error: "Enter a valid 8–14 digit EAN/UPC barcode." });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=code,product_name,brands,quantity,image_front_url,nutriments,serving_size,serving_quantity,allergens_tags`, {
      signal: controller.signal, headers: { "User-Agent": "FitOS/1.0 (food nutrition scanner)" }
    });
    if (!response.ok) return res.status(502).json({ error: "Open Food Facts is temporarily unavailable. Retry or enter the label manually." });
    const payload = await response.json() as { status?: number; product?: any };
    if (payload.status !== 1 || !payload.product) return res.status(404).json({ error: "Product not found in Open Food Facts. Enter nutrition from the package label." });
    const p = payload.product, n = p.nutriments || {};
    // The API response declares its nutrition basis as per_100g, so never
    // silently substitute per-serving values into these fields.
    const per100g = (key: string) => numberOrNull(n[key]);
    const calories = per100g("energy-kcal_100g") ??
      (per100g("energy_100g") === null ? null : Math.round(per100g("energy_100g")! / 4.184 * 100) / 100);
    return res.json({ product: {
      barcode, name: p.product_name || "", brand: p.brands || "", packageSize: p.quantity || "",
      servingSize: p.serving_size || "", servingQuantityG: numberOrNull(p.serving_quantity),
      imageUrl: p.image_front_url || null, source: "Open Food Facts",
      sourceUrl: `https://world.openfoodfacts.org/product/${barcode}`,
      nutrition: { basis: "per_100g", caloriesKcal: calories,
        proteinG: per100g("proteins_100g"),
        carbsG: per100g("carbohydrates_100g"),
        fatG: per100g("fat_100g"),
        sugarsG: per100g("sugars_100g"),
        fiberG: per100g("fiber_100g"),
        saturatedFatG: per100g("saturated-fat_100g"),
        saltG: per100g("salt_100g") },
      allergens: p.allergens_tags || []
    }});
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error && error.name === "AbortError" ? "Open Food Facts request timed out." : "Could not reach Open Food Facts. Check your connection or enter the label manually." });
  } finally { clearTimeout(timeout); }
});

foodScannerRouter.get("/logs", async (req: AuthedRequest, res) => {
  const date = typeof req.query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : new Date().toISOString().slice(0, 10);
  const logs = await db.all<any>("SELECT id,loggedAt,localDate,mealType,foodName,barcode,servingDescription,servings,caloriesKcal,proteinG,carbsG,fatG,source,verificationStatus FROM FoodLog WHERE userId = ? AND localDate = ? ORDER BY loggedAt DESC", req.userId!, date);
  const totals = logs.reduce((sum, row) => ({ caloriesKcal: sum.caloriesKcal + Number(row.caloriesKcal || 0), proteinG: sum.proteinG + Number(row.proteinG || 0), carbsG: sum.carbsG + Number(row.carbsG || 0), fatG: sum.fatG + Number(row.fatG || 0) }), { caloriesKcal: 0, proteinG: 0, carbsG: 0, fatG: 0 });
  res.json({ date, logs, totals });
});

foodScannerRouter.post("/logs", async (req: AuthedRequest, res) => {
  const b = req.body || {}, name = typeof b.foodName === "string" ? b.foodName.trim().slice(0, 180) : "";
  const servings = Number(b.servings ?? 1), values = [Number(b.caloriesKcal), Number(b.proteinG), Number(b.carbsG), Number(b.fatG)];
  if (!name || !Number.isFinite(servings) || servings <= 0 || servings > 50 || values.some(n => !Number.isFinite(n) || n < 0 || n > 100000)) return res.status(400).json({ error: "Review the food name, serving count, and non-negative nutrition values." });
  const date = typeof b.localDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.localDate) ? b.localDate : new Date().toISOString().slice(0, 10);
  const barcode = typeof b.barcode === "string" && /^\d{8,14}$/.test(b.barcode) ? b.barcode : null;
  const requestKey = typeof b.requestKey === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(b.requestKey) ? b.requestKey : uuidv4();
  const existing = await db.get<any>("SELECT id FROM FoodLog WHERE userId = ? AND requestKey = ?", req.userId!, requestKey);
  if (existing) return res.status(200).json({ id: existing.id, duplicate: true });
  const id = uuidv4(), loggedAt = nowIso(), source = b.source === "Open Food Facts" ? "Open Food Facts" : "manual";
  await db.run("INSERT INTO FoodLog (id,userId,requestKey,loggedAt,localDate,mealType,foodName,barcode,servingDescription,servings,caloriesKcal,proteinG,carbsG,fatG,source,sourceUrl,verificationStatus) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    id, req.userId!, requestKey, loggedAt, date, ["breakfast","lunch","dinner","snack"].includes(b.mealType) ? b.mealType : "snack", name, barcode,
    typeof b.servingDescription === "string" ? b.servingDescription.slice(0,100) : "1 serving", servings,
    values[0] * servings, values[1] * servings, values[2] * servings, values[3] * servings, source,
    source === "Open Food Facts" && barcode ? `https://world.openfoodfacts.org/product/${barcode}` : null, b.verified === true ? "user-confirmed" : "needs-review");
  res.status(201).json({ id, loggedAt, localDate: date, foodName: name, servings, caloriesKcal: values[0] * servings, proteinG: values[1] * servings, carbsG: values[2] * servings, fatG: values[3] * servings, source });
});

foodScannerRouter.delete("/logs/:id", async (req: AuthedRequest, res) => {
  const result = await db.run("DELETE FROM FoodLog WHERE id = ? AND userId = ?", String(req.params.id), req.userId!);
  if (!result.changes) return res.status(404).json({ error: "Food log not found." });
  res.status(204).end();
});
