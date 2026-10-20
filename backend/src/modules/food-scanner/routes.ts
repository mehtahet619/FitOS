import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { db, nowIso } from "../../db/client";
import { AuthedRequest, requireAuth } from "../../common/auth";

export const foodScannerRouter = Router();

// Overridable so tests (and staging) can point at a fake Open Food Facts server.
const OFF_BASE = (process.env.OPENFOODFACTS_BASE_URL || "https://world.openfoodfacts.org").replace(/\/$/, "");
const OFF_SEARCH_URL = process.env.OPENFOODFACTS_SEARCH_URL || "https://search.openfoodfacts.org/search";
const OFF_PUBLIC_BASE = "https://world.openfoodfacts.org";
const OFF_TIMEOUT_MS = Number(process.env.OPENFOODFACTS_TIMEOUT_MS) || 7000;
const OFF_FIELDS = "code,product_name,brands,quantity,serving_size,serving_quantity,nutriments,image_front_small_url,ingredients_text,allergens,ecoscore_grade,nova_group";
const PRODUCT_CODE = /^(?:[0-9]{8}|[0-9]{12,14})$/;
const optionalNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100000 ? n : null;
};
function normalizeProduct(raw: any) {
  const n = raw?.nutriments || {};
  // Prefer the explicit kcal field; fall back to kJ (energy_100g) / 4.184 for records that only store kJ.
  const kcal = optionalNumber(n["energy-kcal_100g"]);
  const kj = optionalNumber(n.energy_100g);
  const calories = kcal !== null ? kcal : kj !== null ? Math.round((kj / 4.184) * 10) / 10 : null;
  const sodiumG = optionalNumber(n.sodium_100g);
  const caffeineG = optionalNumber(n.caffeine_100g);
  const servingQuantity = optionalNumber(raw?.serving_quantity);
  return {
    code: String(raw?.code || ""),
    name: String(raw?.product_name || "").trim(),
    brand: String(raw?.brands || "").trim(),
    quantity: String(raw?.quantity || "").trim(),
    servingSize: String(raw?.serving_size || "").trim(),
    servingQuantityG: servingQuantity !== null && servingQuantity > 0 ? servingQuantity : null,
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
      sodiumMg: sodiumG === null ? null : Math.round(sodiumG * 1000 * 10) / 10,
      caffeineMg: caffeineG === null ? null : Math.round(caffeineG * 1000 * 10) / 10,
    },
    source: "Open Food Facts",
    sourceUrl: OFF_PUBLIC_BASE + "/product/" + encodeURIComponent(String(raw?.code || "")),
    verificationStatus: "community_database_unverified",
  };
}
class OffError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}
// Turns every failure mode (timeout, DNS/network, 429, 5xx, bad JSON) into a short, user-safe message.
async function offFetchOnce(url: string, timeoutMs: number) {
  let response: Response;
  try {
    response = await fetch(url, { headers: { "User-Agent": "FitOS/1.0 (food scanner)" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") throw new OffError("Open Food Facts took too long to respond. Please try again, or enter the label manually.", 504);
    throw new OffError("Could not reach Open Food Facts. Check your connection and try again, or enter the label manually.");
  }
  if (response.status === 404) return { notFound: true as const, data: null as any };
  if (response.status === 429) throw new OffError("Open Food Facts is rate-limiting requests right now. Please wait a moment and try again.", 503);
  if (!response.ok) throw new OffError("Open Food Facts is temporarily unavailable. Please try again, or enter the label manually.");
  try {
    return { notFound: false as const, data: (await response.json()) as any };
  } catch {
    throw new OffError("Open Food Facts returned an unreadable response. Please try again.");
  }
}
async function offFetch(url: string, timeoutMs = OFF_TIMEOUT_MS) {
  try {
    return await offFetchOnce(url, timeoutMs);
  } catch (error) {
    // One retry for transient upstream failures; never for rate limiting.
    if (error instanceof OffError && error.status !== 503) return offFetchOnce(url, timeoutMs);
    throw error;
  }
}
foodScannerRouter.get("/foods/barcode/:code", async (req, res) => {
  const code = String(req.params.code || "").trim();
  if (!PRODUCT_CODE.test(code)) return res.status(400).json({ error: "Enter a valid EAN/UPC barcode (8, 12, 13, or 14 digits)." });
  try {
    // Open Food Facts stores UPC-A (12 digit) products as zero-padded EAN-13, so try both spellings.
    const candidates = code.length === 12 ? [code, "0" + code] : [code];
    let product: ReturnType<typeof normalizeProduct> | null = null;
    let sawRecordWithoutName = false;
    for (const candidate of candidates) {
      const { notFound, data } = await offFetch(`${OFF_BASE}/api/v2/product/${encodeURIComponent(candidate)}.json?fields=${OFF_FIELDS}`);
      if (notFound || data?.status !== 1 || !data?.product) continue;
      const normalized = normalizeProduct({ ...data.product, code });
      if (!normalized.name) { sawRecordWithoutName = true; continue; }
      product = normalized;
      break;
    }
    if (product) return res.json({ found: true, product });
    if (sawRecordWithoutName) return res.status(422).json({ found: false, code, error: "The product record has no name. Use manual entry after checking the package label." });
    return res.status(404).json({ found: false, code, error: "Product not found in Open Food Facts. Search by name or enter the package label manually." });
  } catch (error) {
    if (error instanceof OffError) return res.status(error.status).json({ error: error.message });
    return res.status(502).json({ error: "Open Food Facts lookup failed. Please try again." });
  }
});
foodScannerRouter.get("/foods/search", async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 100);
  if (q.length < 2) return res.status(400).json({ error: "Enter at least two characters to search." });

  // All upstream calls stay on the FitOS server. Browsers cannot reliably call
  // Open Food Facts directly because of cross-origin restrictions.
  let primaryError = false;
  try {
    const url = new URL(OFF_SEARCH_URL);
    url.searchParams.set("q", q);
    url.searchParams.set("langs", "en");
    url.searchParams.set("page", "1");
    url.searchParams.set("page_size", "20");
    url.searchParams.set("fields", OFF_FIELDS);
    const response = await fetch(url.toString(), {
      headers: { "User-Agent": "FitOS/1.0 (food scanner)" },
      signal: AbortSignal.timeout(Math.max(OFF_TIMEOUT_MS, 12000)),
    });
    if (response.ok) {
      const data = await response.json() as any;
      const hits = Array.isArray(data?.hits) ? data.hits : [];
      const products = hits
        .map((hit: any) => hit?._source ?? hit?.document ?? hit)
        .filter((p: any) => p?.code && (p?.product_name || p?.product_name_en))
        .map((p: any) => normalizeProduct({
          ...p,
          product_name: p.product_name || p.product_name_en || "",
        }));
      if (products.length) return res.json({ products, source: "Open Food Facts", count: products.length });
    } else {
      primaryError = true;
      console.error("[food-search] Search-a-licious returned HTTP", response.status);
    }
  } catch (error) {
    primaryError = true;
    console.error("[food-search] Search-a-licious request failed:", error instanceof Error ? error.message : "unknown error");
  }

  // Compatibility fallback for Search-a-licious outages. This request is made
  // server-side, never from the user's browser.
  try {
    const fallbackUrl = new URL(OFF_BASE + "/cgi/search.pl");
    fallbackUrl.searchParams.set("search_terms", q);
    fallbackUrl.searchParams.set("search_simple", "1");
    fallbackUrl.searchParams.set("action", "process");
    fallbackUrl.searchParams.set("json", "1");
    fallbackUrl.searchParams.set("page_size", "20");
    fallbackUrl.searchParams.set("fields", OFF_FIELDS);
    const fallbackResponse = await fetch(fallbackUrl.toString(), {
      headers: { "User-Agent": "FitOS/1.0 (food scanner)", Accept: "application/json" },
      signal: AbortSignal.timeout(Math.max(OFF_TIMEOUT_MS, 12000)),
    });
    if (fallbackResponse.ok) {
      const data = await fallbackResponse.json() as any;
      const products = (Array.isArray(data?.products) ? data.products : [])
        .filter((p: any) => p?.code && (p?.product_name || p?.product_name_en))
        .map((p: any) => normalizeProduct({
          ...p,
          product_name: p.product_name || p.product_name_en || "",
        }));
      return res.json({ products, source: "Open Food Facts", count: products.length });
    }
    console.error("[food-search] legacy fallback returned HTTP", fallbackResponse.status);
  } catch (error) {
    console.error("[food-search] legacy fallback failed:", error instanceof Error ? error.message : "unknown error");
  }

  return res.status(502).json({
    error: primaryError
      ? "Open Food Facts search is temporarily unavailable. Please try again shortly."
      : "No matching products were returned. Try another spelling or a shorter query.",
  });
});
// A "day" is the user's local calendar day. The client sends its UTC offset (Date#getTimezoneOffset, minutes
// west of UTC) so entries logged just after local midnight do not show up under the previous UTC date.
function dayWindow(query: Record<string, unknown>) {
  const date = typeof query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(query.date) ? query.date : new Date().toISOString().slice(0, 10);
  const rawOffset = typeof query.tzOffset === "string" && /^-?\d{1,4}$/.test(query.tzOffset) ? Number(query.tzOffset) : 0;
  const offset = Math.abs(rawOffset) <= 14 * 60 ? rawOffset : 0;
  const [y, m, d] = date.split("-").map(Number);
  const start = Date.UTC(y, m - 1, d) + offset * 60000;
  return { date, from: new Date(start).toISOString(), to: new Date(start + 86400000).toISOString() };
}
foodScannerRouter.get("/logs", requireAuth, async (req: AuthedRequest, res) => {
  const { date, from, to } = dayWindow(req.query);
  const rows = await db.all<any>(
    `SELECT id, product_code AS "productCode", food_name AS "foodName", brand, serving_amount AS "servingAmount",
      serving_unit AS "servingUnit", calories_kcal AS "caloriesKcal", protein_g AS "proteinG",
      carbs_g AS "carbsG", fat_g AS "fatG", fiber_g AS "fiberG", source, source_url AS "sourceUrl",
      verification_status AS "verificationStatus", logged_at AS "loggedAt"
     FROM food_log WHERE user_id = ? AND logged_at >= ? AND logged_at < ? ORDER BY logged_at DESC LIMIT 200`,
    req.userId!, from, to
  );
  const totals = rows.reduce((acc: any, row: any) => {
    for (const key of ["caloriesKcal", "proteinG", "carbsG", "fatG", "fiberG"]) {
      if (row[key] !== null && row[key] !== undefined) acc[key] += Number(row[key]);
    }
    return acc;
  }, { caloriesKcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 });
  for (const key of Object.keys(totals)) totals[key] = Math.round(totals[key] * 100) / 100;
  return res.json({ date, entries: rows, totals, note: "Totals sum only available values; missing nutrients are not treated as zero." });
});
foodScannerRouter.post("/logs", requireAuth, async (req: AuthedRequest, res) => {
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
  const sourceUrl = source === "open_food_facts" && code ? OFF_PUBLIC_BASE + "/product/" + encodeURIComponent(code) : null;
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
foodScannerRouter.patch("/logs/:id", requireAuth, async (req: AuthedRequest, res) => {
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
foodScannerRouter.delete("/logs/:id", requireAuth, async (req: AuthedRequest, res) => {
  const result = await db.run("DELETE FROM food_log WHERE id = ? AND user_id = ?", String(req.params.id || ""), req.userId!);
  if (!result.changes) return res.status(404).json({ error: "Food log entry not found." });
  return res.json({ success: true });
});
