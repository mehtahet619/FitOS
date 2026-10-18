import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NUTELLA, startHarness } from "./helpers/foodHarness";

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: { userId: string; token: string };
let bob: { userId: string; token: string };
const get = async (p: string, token?: string) => { const r = await fetch(h.apiBase + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} }); return { status: r.status, body: await r.json().catch(() => null) as any }; };
const send = async (method: string, p: string, body?: unknown, token?: string) => {
  const r = await fetch(h.apiBase + p, { method, headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};

beforeAll(async () => { h = await startHarness(); alice = await h.makeUser("alice"); bob = await h.makeUser("bob"); });
afterAll(async () => { await h.close(); });
beforeEach(() => { h.setOff(() => ({ status: 404, body: { status: 0 } })); });

describe("barcode lookup: Open Food Facts responses", () => {
  it("rejects malformed barcodes without calling upstream", async () => {
    for (const bad of ["123", "abcdefgh", "12345678901", "123456789012345"]) expect((await get(`/nutrition/foods/barcode/${bad}`)).status).toBe(400);
    expect(h.offCalls).toHaveLength(0);
  });
  it("maps a found product with a per-100g basis, serving size and unit conversions", async () => {
    h.setOff(() => ({ body: NUTELLA }));
    const { status, body } = await get("/nutrition/foods/barcode/3017620422003");
    expect(status).toBe(200);
    expect(body.product).toMatchObject({ code: "3017620422003", name: "Nutella", brand: "Ferrero", servingQuantityG: 15, source: "Open Food Facts" });
    const n = body.product.nutrimentsPer100g;
    expect(n.basis).toMatch(/per 100/);
    // per-serving fields (energy-kcal_serving: 80.9) must never leak into the per-100g values
    expect(n).toMatchObject({ caloriesKcal: 539, proteinG: 6.3, carbsG: 57.5, fatG: 30.9, fiberG: 0, sodiumMg: 42.8 });
  });
  it("falls back to kJ→kcal when only energy_100g is present, and keeps missing nutrients null (not zero)", async () => {
    h.setOff(() => ({ body: { status: 1, product: { product_name: "Mystery", nutriments: { energy_100g: 418.4 } } } }));
    const n = (await get("/nutrition/foods/barcode/12345670")).body.product.nutrimentsPer100g;
    expect(n.caloriesKcal).toBe(100);
    expect(n.proteinG).toBeNull(); expect(n.fatG).toBeNull();
  });
  it("does not use per-serving values when per-100g is missing", async () => {
    h.setOff(() => ({ body: { status: 1, product: { product_name: "Serving only", nutriments: { "energy-kcal_serving": 200 } } } }));
    expect((await get("/nutrition/foods/barcode/12345670")).body.product.nutrimentsPer100g.caloriesKcal).toBeNull();
  });
  it("404 when product is not in the database (status 0)", async () => {
    const r = await get("/nutrition/foods/barcode/3017620422003");
    expect(r.status).toBe(404); expect(r.body.error).toMatch(/not found/i);
  });
  it("404 when upstream answers HTTP 404", async () => {
    h.setOff(() => ({ status: 404, body: { status: 0 } }));
    expect((await get("/nutrition/foods/barcode/3017620422003")).status).toBe(404);
  });
  it("422 when the record has no name", async () => {
    h.setOff(() => ({ body: { status: 1, product: { product_name: "", nutriments: {} } } }));
    expect((await get("/nutrition/foods/barcode/3017620422003")).status).toBe(422);
  });
  it("tries the zero-padded EAN-13 for UPC-A (12 digit) codes", async () => {
    h.setOff((url) => (url.pathname.includes("/0737628064502.json") ? { body: { status: 1, product: { product_name: "Padded", nutriments: {} } } } : { body: { status: 0 } }));
    const r = await get("/nutrition/foods/barcode/737628064502");
    expect(r.status).toBe(200); expect(r.body.product.code).toBe("737628064502");
    expect(h.offCalls).toHaveLength(2);
  });
  it("retries once on a transient 5xx and succeeds", async () => {
    h.setOff((_u, call) => (call === 1 ? { status: 503, body: {} } : { body: NUTELLA }));
    expect((await get("/nutrition/foods/barcode/3017620422003")).status).toBe(200);
    expect(h.offCalls).toHaveLength(2);
  });
  it("502 with a friendly message when upstream keeps failing", async () => {
    h.setOff(() => ({ status: 500, body: {} }));
    const r = await get("/nutrition/foods/barcode/3017620422003");
    expect(r.status).toBe(502); expect(r.body.error).toMatch(/temporarily unavailable/);
  });
  it("504 on timeout (no raw 'aborted due to timeout' text)", async () => {
    h.setOff(() => ({ body: NUTELLA, delayMs: 1500 }));
    const r = await get("/nutrition/foods/barcode/3017620422003");
    expect(r.status).toBe(504); expect(r.body.error).toMatch(/too long/); expect(r.body.error).not.toMatch(/aborted/i);
  });
  it("429 is surfaced as a rate-limit message and not retried", async () => {
    h.setOff(() => ({ status: 429, body: {} }));
    const r = await get("/nutrition/foods/barcode/3017620422003");
    expect(r.status).toBe(503); expect(r.body.error).toMatch(/rate-limiting/); expect(h.offCalls).toHaveLength(1);
  });
  it("502 on invalid JSON from upstream", async () => {
    h.setOff(() => ({ raw: "<html>oops</html>" }));
    const r = await get("/nutrition/foods/barcode/3017620422003");
    expect(r.status).toBe(502); expect(r.body.error).toMatch(/unreadable/);
  });
});

describe("food diary: authentication, persistence, isolation", () => {
  it("requires authentication for every diary endpoint, but not for lookup", async () => {
    expect((await get("/nutrition/logs")).status).toBe(401);
    expect((await send("POST", "/nutrition/logs", { foodName: "x", servingAmount: 1 })).status).toBe(401);
    expect((await send("DELETE", "/nutrition/logs/abc")).status).toBe(401);
    expect((await get("/nutrition/logs", "not-a-jwt")).status).toBe(401);
    h.setOff(() => ({ body: NUTELLA }));
    expect((await get("/nutrition/foods/barcode/3017620422003")).status).toBe(200);
  });
  it("saves a scanned product and returns it (with totals) on the next fetch", async () => {
    const save = await send("POST", "/nutrition/logs", { productCode: "3017620422003", foodName: "Nutella", brand: "Ferrero", servingAmount: 30, servingUnit: "g", caloriesKcal: 161.7, proteinG: 1.89, carbsG: 17.25, fatG: 9.27, fiberG: null, source: "open_food_facts" }, alice.token);
    expect(save.status).toBe(201);
    const day = await get("/nutrition/logs", alice.token);
    const entry = day.body.entries.find((e: any) => e.id === save.body.id);
    expect(entry).toMatchObject({ foodName: "Nutella", servingAmount: 30, caloriesKcal: 161.7, fiberG: null, source: "open_food_facts", verificationStatus: "user_confirmed", sourceUrl: "https://world.openfoodfacts.org/product/3017620422003" });
    expect(day.body.totals.caloriesKcal).toBe(161.7);
  });
  it("validates input", async () => {
    for (const body of [{}, { foodName: "x", servingAmount: 0 }, { foodName: "x", servingAmount: 20000 }, { foodName: "x", servingAmount: 5, caloriesKcal: -1 }, { foodName: "x", servingAmount: 5, proteinG: "abc" }])
      expect((await send("POST", "/nutrition/logs", body, alice.token)).status).toBe(400);
  });
  it("blocks an accidental double-submit of the same barcode within 10s", async () => {
    const body = { productCode: "12345670", foodName: "Dup", servingAmount: 10, caloriesKcal: 1, source: "open_food_facts" };
    expect((await send("POST", "/nutrition/logs", body, bob.token)).status).toBe(201);
    const second = await send("POST", "/nutrition/logs", body, bob.token);
    expect(second.status).toBe(409); expect(second.body.duplicate).toBe(true);
  });
  it("isolates users: nobody sees or deletes another user's entries", async () => {
    const bobs = await get("/nutrition/logs", bob.token);
    expect(bobs.body.entries.some((e: any) => e.foodName === "Nutella")).toBe(false);
    const aliceEntry = (await get("/nutrition/logs", alice.token)).body.entries[0];
    expect((await send("DELETE", `/nutrition/logs/${aliceEntry.id}`, undefined, bob.token)).status).toBe(404);
    expect((await get("/nutrition/logs", alice.token)).body.entries.some((e: any) => e.id === aliceEntry.id)).toBe(true);
    expect((await send("DELETE", `/nutrition/logs/${aliceEntry.id}`, undefined, alice.token)).status).toBe(200);
    expect((await get("/nutrition/logs", alice.token)).body.entries.some((e: any) => e.id === aliceEntry.id)).toBe(false);
  });
  it("does not treat missing nutrients as zero in totals", async () => {
    const carol = await h.makeUser("carol");
    await send("POST", "/nutrition/logs", { foodName: "A", servingAmount: 10, caloriesKcal: 50, proteinG: null }, carol.token);
    const t = (await get("/nutrition/logs", carol.token)).body;
    expect(t.totals).toMatchObject({ caloriesKcal: 50, proteinG: 0 }); expect(t.entries[0].proteinG).toBeNull();
  });
  it("uses the client's local calendar day: an entry logged after local midnight is not shown under the previous day", async () => {
    const dave = await h.makeUser("dave");
    // 2026-10-18T20:00Z is 2026-10-19 01:30 in UTC+5:30 (getTimezoneOffset = -330)
    await h.db.run(`INSERT INTO food_log (id,user_id,food_name,serving_amount,serving_unit,source,verification_status,logged_at,created_at,updated_at) VALUES ('late-1',?, 'Late snack',100,'g','manual_entry','user_confirmed','2026-10-18T20:00:00.000Z','x','x')`, dave.userId);
    const ist19 = await get("/nutrition/logs?date=2026-10-19&tzOffset=-330", dave.token);
    const ist18 = await get("/nutrition/logs?date=2026-10-18&tzOffset=-330", dave.token);
    const utc18 = await get("/nutrition/logs?date=2026-10-18", dave.token);
    expect(ist19.body.entries.map((e: any) => e.id)).toEqual(["late-1"]);
    expect(ist18.body.entries).toHaveLength(0);
    expect(utc18.body.entries.map((e: any) => e.id)).toEqual(["late-1"]); // old behaviour kept when no offset is sent
  });
});

describe("product search", () => {
  it("maps Search-a-licious hits and reports upstream failure as 502", async () => {
    h.setOff(() => ({ body: { hits: [{ code: "3017620422003", product_name: "Nutella", nutriments: { "energy-kcal_100g": 539 } }, { code: "1", product_name: "" }] } }));
    const ok = await get("/nutrition/foods/search?q=nutella");
    expect(ok.status).toBe(200); expect(ok.body.products).toHaveLength(1); expect(ok.body.products[0].nutrimentsPer100g.caloriesKcal).toBe(539);
    h.setOff(() => ({ status: 500, body: {} }));
    expect((await get("/nutrition/foods/search?q=nutella")).status).toBe(502);
    expect((await get("/nutrition/foods/search?q=n")).status).toBe(400);
  });
});
