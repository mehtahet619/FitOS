import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { db, nowIso } from "../../db/client";
import { AuthedRequest, requireAuth } from "../../common/auth";

export const foodScannerRouter = Router();
foodScannerRouter.use(requireAuth);

const OFF_BASE = "https://world.openfoodfacts.org";
const OFF_FIELDS = "code,product_name,brands,quantity,serving_size,nutriments,image_front_small_url,ingredients_text,allergens,ecoscore_grade,nova_group";
const PRODUCT_CODE = /^(?:[0-9]{8}|[0-9]{12,14})$/;
const optionalNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100000 ? n : null;
};
function normalizeProduct(raw: any) {
  const n = raw?.nutriments || {};
  const calories = optionalNumber(n["energy-kcal_100g"]);
  return {
    code: String(raw?.code || ""),
    name: String(raw?.product_name || "").trim(),
    brand: String(raw?.brands || "").trim(),
    quantity: String(raw?.quantity || "").trim(),
    servingSize: String(raw?.serving_size || "").trim(),
    imageUrl: typeof raw?.image_front_small_url === "string" && /^https:\/\//i.test(raw.image_front_small_url) ? raw.image_front_small_url : null,
    ingredients: String(raw?.ingredients_text || "").slice(0, 2000),
    allergens: String(raw?.allergens || "").slice(0, 500),
    nutrimentsPer100g: {
      basis: "per 100 g/ml as reported by Open Food Facts",
      caloriesKcal: calories,
      proteinG: optionalNumber(n.proteins_100g),
      carbsG: optionalNumber(n.carbohydrates_100g),
      fatG: optionalNumber(n.fat_100g),
      fiberG: optionalNumber(n.fiber_100g),
      saturatedFatG: optionalNumber(n["saturated-fat_100g"]),
      sugarsG: optionalNumber(n.sugars_100g),
      saltG: optionalNumber(n.salt_100g),
      sodiumMg: optionalNumber(n.sodium_100g) === null ? null : Number(n.sodium_100g) * 1000,
      caffeineMg: optionalNumber(n.caffeine_100g) === null ? null : Number(n.caffeine_100g) * 1000,
    },
    source: "Open Food Facts",
    sourceUrl: OFF_BASE + "/product/" + encodeURIComponent(String(raw?.code || "")),
    verificationStatus: "community_database_unverified",
  };
}
async function offFetch(url: string) {
  const response = await fetch(url, {
    headers: { "User-Agent": "FitOS/1.0 (food scanner)" },
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok) throw new Error("Open Food Facts is temporarily unavailable. Please try again.");
  return response.json() as Promise<any>;
}
foodScannerRouter.get("/foods/barcode/:code", async (req, res) => {
  const code = String(req.params.code || "").trim();
  if (!PRODUCT_CODE.test(code)) return res.status(400).json({ error: "Enter a valid EAN/UPC barcode (8, 12, 13, or 14 digits)." });
  try {
    const data = await offFetch(`${OFF_BASE}/api/v2/product/${encodeURIComponent(code)}.json?fields=${OFF_FIELDS}`);
    if (data?.status !== 1 || !data?.product) return res.status(404).json({ found: false, code, error: "Product not found in Open Food Facts. Search by name or enter the package label manually." });
    const product = normalizeProduct({ ...data.product, code });
    if (!product.name) return res.status(422).json({ found: false, code, error: "The product record has no name. Use manual entry after checking the package label." });
    return res.json({ found: true, product });
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? error.message : "Open Food Facts lookup failed." });
  }
});
foodScannerRouter.get("/foods/search", async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 100);
  if (q.length < 2) return res.status(400).json({ error: "Enter at least two characters to search." });
  try {
    const url = new URL(OFF_BASE + "/cgi/search.pl");
    url.searchParams.set("search_terms", q);
    url.searchParams.set("search_simple", "1");
    url.searchParams.set("action", "process");
    url.searchParams.set("json", "1");
    url.searchParams.set("page_size", "10");
    url.searchParams.set("fields", OFF_FIELDS);
    const data = await offFetch(url.toString());
    const products = (Array.isArray(data?.products) ? data.products : [])
      .filter((p: any) => p?.code && p?.product_name)
      .map((p: any) => normalizeProduct(p));
    return res.json({ products, source: "Open Food Facts", count: products.length });
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? error.message : "Open Food Facts search failed." });
  }
});
foodScannerRouter.get("/logs", async (req: AuthedRequest, res) => {
  const date = typeof req.query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
    ? req.query.date : new Date().toISOString().slice(0, 10);
  const rows = await db.all<any>(
    `SELECT id, product_code AS "productCode", food_name AS "foodName", brand, serving_amount AS "servingAmount",
      serving_unit AS "servingUnit", calories_kcal AS "caloriesKcal", protein_g AS "proteinG",
      carbs_g AS "carbsG", fat_g AS "fatG", fiber_g AS "fiberG", source, source_url AS "sourceUrl",
      verification_status AS "verificationStatus", logged_at AS "loggedAt"
     FROM food_log WHERE user_id = ? AND logged_at >= ? AND logged_at < ? ORDER BY logged_at DESC LIMIT 200`,
    req.userId!, date + "T00:00:00.000Z", date + "T23:59:59.999Z"
  );
  const totals = rows.reduce((acc: any, row: any) => {
    for (const key of ["caloriesKcal", "proteinG", "carbsG", "fatG", "fiberG"]) {
      if (row[key] !== null && row[key] !== undefined) acc[key] += Number(row[key]);
    }
    return acc;
  }, { caloriesKcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 });
  return res.json({ date, entries: rows, totals, note: "Totals sum only available values; missing nutrients are not treated as zero." });
});
foodScannerRouter.post("/logs", async (req: AuthedRequest, res) => {
  const b = req.body || {};
  const name = typeof b.foodName === "string" ? b.foodName.trim().slice(0, 120) : "";
  const amount = Number(b.servingAmount);
  const unit = b.servingUnit === "ml" ? "ml" : "g";
  if (!name || !Number.isFinite(amount) || amount <= 0 || amount > 10000) return res.status(400).json({ error: "Food name and a valid serving amount are required." });
  const nutrients: Record<string, number | null> = {};
  for (const key of ["caloriesKcal", "proteinG", "carbsG", "fatG", "fiberG"]) {
    const value = b[key];
    nutrients[key] = value === null || value === undefined || value === "" ? null : Number(value);
    if (nutrients[key] !== null && (!Number.isFinite(nutrients[key]) || nutrients[key]! < 0 || nutrients[key]! > 10000)) return res.status(400).json({ error: `Invalid value for ${key}.` });
  }
  const code = typeof b.productCode === "string" && PRODUCT_CODE.test(b.productCode) ? b.productCode : null;
  const source = ["open_food_facts", "manual_label", "manual_entry"].includes(b.source) ? b.source : "manual_entry";
  const sourceUrl = source === "open_food_facts" && code ? OFF_BASE + "/product/" + encodeURIComponent(code) : null;
  const now = nowIso();
  // Prevent accidental repeat submissions of the same product within 10 seconds.
  if (code) {
    const recent = await db.get<any>("SELECT id FROM food_log WHERE user_id = ? AND product_code = ? AND logged_at >= ?", req.userId!, code, new Date(Date.now() - 10000).toISOString());
    if (recent) return res.status(409).json({ error: "This barcode was just logged. Refresh today’s log instead of adding it twice.", duplicate: true });
  }
  const id = uuidv4();
  await db.run(
    `INSERT INTO food_log (id, user_id, product_code, food_name, brand, serving_amount, serving_unit, calories_kcal, protein_g, carbs_g, fat_g, fiber_g, source, source_url, verification_status, logged_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, req.userId!, code, name, typeof b.brand === "string" ? b.brand.slice(0, 120) : null, amount, unit,
    nutrients.caloriesKcal, nutrients.proteinG, nutrients.carbsG, nutrients.fatG, nutrients.fiberG,
    source, sourceUrl, "user_confirmed", now, now, now
  );
  return res.status(201).json({ id, loggedAt: now });
});
foodScannerRouter.patch("/logs/:id", async (req: AuthedRequest, res) => {
  const id = String(req.params.id || "");
  const b = req.body || {};
  const existing = await db.get<any>("SELECT * FROM food_log WHERE id = ? AND user_id = ?", id, req.userId!);
  if (!existing) return res.status(404).json({ error: "Food log entry not found." });
  const amount = b.servingAmount === undefined ? Number(existing.serving_amount) : Number(b.servingAmount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000) return res.status(400).json({ error: "Invalid serving amount." });
  const name = typeof b.foodName === "string" ? b.foodName.trim().slice(0, 120) : existing.food_name;
  await db.run("UPDATE food_log SET food_name = ?, serving_amount = ?, updated_at = ? WHERE id = ? AND user_id = ?", name, amount, nowIso(), id, req.userId!);
  return res.json({ success: true });
});
foodScannerRouter.delete("/logs/:id", async (req: AuthedRequest, res) => {
  const result = await db.run("DELETE FROM food_log WHERE id = ? AND user_id = ?", String(req.params.id || ""), req.userId!);
  if (!result.changes) return res.status(404).json({ error: "Food log entry not found." });
  return res.json({ success: true });
});
