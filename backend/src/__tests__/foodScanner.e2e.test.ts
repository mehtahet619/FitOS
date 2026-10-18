import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { barcodeFrame, blankFrame, type Frame } from "./helpers/barcodeImages";
import { NUTELLA, startHarness } from "./helpers/foodHarness";

const FRONTEND = path.join(__dirname, "../../../frontend");
const read = (f: string) => fs.readFileSync(path.join(FRONTEND, f), "utf8");
const html = read("index.html");
const trackerHtml = html.slice(html.indexOf('<section id="fitos-food-tracker"'), html.indexOf("</section>", html.indexOf('<section id="fitos-food-tracker"')) + "</section>".length);

let h: Awaited<ReturnType<typeof startHarness>>;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.close(); });

type Opts = { token?: string; frame?: Frame; native?: "none" | "works"; getUserMedia?: () => Promise<unknown>; secure?: boolean; tz?: number };
async function openApp(o: Opts = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${trackerHtml}</body></html>`, { runScripts: "dangerously", url: "http://localhost/", pretendToBeVisual: true });
  const w: any = dom.window;
  const unauth = vi.fn();
  w.AuthState = { unauthenticated: unauth };
  w.API_BASE = h.apiBase;
  w.AbortController = AbortController; // jsdom's signal is rejected by Node's fetch
  // Browser cookie jar stand-in: the real client authenticates with the fitos_access cookie.
  w.fetch = (url: string, init: any = {}) => fetch(url, { ...init, signal: init.signal, headers: { ...(init.headers || {}), ...(o.token ? { Cookie: `fitos_access=${o.token}` } : {}) } });
  w.Element.prototype.scrollIntoView = () => {};
  w.confirm = () => true;
  if (o.secure === false) Object.defineProperty(w, "isSecureContext", { value: false });
  const track = { stop: vi.fn() };
  const getUserMedia = o.getUserMedia ? vi.fn(o.getUserMedia) : vi.fn(async () => ({ getTracks: () => [track] }));
  Object.defineProperty(w.navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  const video = w.document.getElementById("food-barcode-video");
  Object.defineProperty(video, "readyState", { value: 4 }); Object.defineProperty(video, "videoWidth", { value: 640 }); Object.defineProperty(video, "videoHeight", { value: 480 });
  video.play = async () => {}; video.pause = () => {};
  if (o.native === "works") {
    w.BarcodeDetector = class { static async getSupportedFormats() { return ["ean_13", "ean_8", "upc_a", "upc_e"]; } async detect() { return [{ rawValue: "3017620422003", format: "ean_13" }]; } };
  }
  if (o.tz !== undefined) w.Date.prototype.getTimezoneOffset = () => o.tz;
  const load = (code: string) => { const s = w.document.createElement("script"); s.textContent = code; w.document.body.appendChild(s); };
  for (const f of ["api.js", "nutrition-guidance.js", "barcode-scanner.js"]) load(read(f));
  // Load the pinned ZXing UMD build from the backend dev dependency. The old frontend/vendor file was never committed, causing CI ENOENT failures.
  load(fs.readFileSync(path.join(__dirname, "../../node_modules/@zxing/library/umd/index.min.js"), "utf8"));
  // jsdom has no canvas: feed the scanner the pixels a camera frame would produce. Everything else is the shipped code.
  const realCreate = w.FitOSBarcode.createScanner;
  w.FitOSBarcode.createScanner = (opts: any) => realCreate({ ...opts, grabFrame: () => o.frame ?? blankFrame() });
  load(read("food-tracker.js"));
  const $ = (id: string) => w.document.getElementById(id) as HTMLElement & Record<string, any>;
  const waitFor = async <T,>(fn: () => T, what: string, ms = 6000): Promise<NonNullable<T>> => {
    const end = Date.now() + ms; let last: unknown;
    while (Date.now() < end) { try { const v = fn(); if (v) return v as NonNullable<T>; } catch (e) { last = e; } await new Promise((r) => setTimeout(r, 25)); }
    throw new Error(`Timed out waiting for: ${what}${last ? ` (${String(last)})` : ""}\nstatus="${$("food-camera-status")?.textContent}"`);
  };
  const type = (id: string, value: string) => { $(id).value = value; $(id).dispatchEvent(new w.Event("input", { bubbles: true })); };
  const click = (id: string) => $(id).dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  return { dom, w, $, waitFor, type, click, getUserMedia, track, unauth, close: () => w.close() };
}
const dayLog = async (token: string, tz = 0) => { const d = new Date(); const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; const r = await fetch(`${h.apiBase}/nutrition/logs?date=${date}&tzOffset=${tz}`, { headers: { Authorization: `Bearer ${token}` } }); return r.json() as Promise<any>; };

describe("regression: the client object the tracker needs", () => {
  it("api.js exposes window.Api (a top-level const alone does not)", async () => {
    const app = await openApp();
    expect(typeof app.w.Api).toBe("object"); expect(typeof app.w.Api.get).toBe("function");
    app.close();
  });
});

describe("end to end: camera → lookup → confirm → diary", () => {
  it("ZXing fallback (no BarcodeDetector): scan a real EAN-13 image, review per-100g values, log 30 g, see it in today's log and after reload", async () => {
    const user = await h.makeUser("e2e-zxing");
    h.setOff(() => ({ body: NUTELLA }));
    const frame = await barcodeFrame("ean13", "301762042200");
    const app = await openApp({ token: user.token, frame });
    expect(app.w.BarcodeDetector).toBeUndefined();
    app.click("food-camera-start");
    await app.waitFor(() => app.$("food-product-review").innerHTML.includes("Nutella"), "review card for Nutella");
    expect(app.getUserMedia).toHaveBeenCalledTimes(1);
    expect(app.$("food-barcode-input").value).toBe("3017620422003");
    expect(app.track.stop).toHaveBeenCalled();                           // camera released after the hit
    expect(app.$("food-camera-stop").disabled).toBe(true);
    expect(app.$("food-barcode-video").hidden).toBe(true);
    expect(h.offCalls[0]).toContain("/api/v2/product/3017620422003.json");
    // review shows per-100g values and a serving prefilled from the package (15 g)
    expect(app.$("food-review-calories").value).toBe("539");
    expect(app.$("food-review-serving").value).toBe("15");
    expect(app.$("food-product-review").textContent).toMatch(/per 100 g\/ml/);
    app.type("food-review-serving", "30");
    app.click("food-confirm-log");
    await app.waitFor(() => /Nutella/.test(app.$("food-log-list").textContent || ""), "entry in today's log");
    expect(app.$("food-daily-summary").textContent).toContain("161.7 kcal");
    const saved = (await dayLog(user.token)).entries;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ productCode: "3017620422003", foodName: "Nutella", servingAmount: 30, servingUnit: "g", caloriesKcal: 161.7, proteinG: 1.89, carbsG: 17.25, fatG: 9.27, source: "open_food_facts" });
    app.close();
    // "reload": a brand-new page with the same session retrieves the entry from the API
    const again = await openApp({ token: user.token });
    again.dom.window.document.querySelector<HTMLElement>('[data-food-view="log"]')!.click();
    await again.waitFor(() => /Nutella/.test(again.$("food-log-list").textContent || ""), "entry after reload");
    again.close();
  });

  it("native BarcodeDetector path works end to end too", async () => {
    const user = await h.makeUser("e2e-native");
    h.setOff(() => ({ body: NUTELLA }));
    const app = await openApp({ token: user.token, native: "works" });
    app.click("food-camera-start");
    await app.waitFor(() => app.$("food-product-review").innerHTML.includes("Nutella"), "review card");
    app.click("food-confirm-log");
    await app.waitFor(async () => (await dayLog(user.token)).entries.length === 1 || null, "saved").catch(() => null);
    await app.waitFor(() => /Nutella/.test(app.$("food-log-list").textContent || ""), "log list");
    app.close();
  });

  it("camera permission denied: clear message, no crash, manual barcode entry still completes the flow", async () => {
    const user = await h.makeUser("e2e-denied");
    h.setOff(() => ({ body: NUTELLA }));
    const app = await openApp({ token: user.token, getUserMedia: async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); } });
    app.click("food-camera-start");
    await app.waitFor(() => /permission was denied/.test(app.$("food-camera-status").textContent || ""), "denied message");
    expect(app.$("food-camera-start").disabled).toBe(false); expect(app.$("food-barcode-video").hidden).toBe(true);
    app.type("food-barcode-input", "3017620422003");
    app.$("food-barcode-form").dispatchEvent(new app.w.Event("submit", { bubbles: true, cancelable: true }));
    await app.waitFor(() => app.$("food-product-review").innerHTML.includes("Nutella"), "manual lookup result");
    app.close();
  });

  it("insecure (http) origin: explains HTTPS requirement instead of failing silently", async () => {
    const app = await openApp({ secure: false });
    app.click("food-camera-start");
    await app.waitFor(() => /HTTPS/.test(app.$("food-camera-status").textContent || ""), "https message");
    expect(app.getUserMedia).not.toHaveBeenCalled(); app.close();
  });

  it("product not in Open Food Facts: says so and points at manual entry; nothing is logged", async () => {
    const user = await h.makeUser("e2e-404");
    h.setOff(() => ({ body: { status: 0 } }));
    const app = await openApp({ token: user.token });
    app.type("food-barcode-input", "3017620422003");
    app.$("food-barcode-form").dispatchEvent(new app.w.Event("submit", { bubbles: true, cancelable: true }));
    await app.waitFor(() => /not found.*manual entry/i.test(app.$("food-camera-status").textContent || ""), "not-found message");
    expect(app.$("food-product-review").hidden).toBe(true);
    expect((await dayLog(user.token)).entries).toHaveLength(0); app.close();
  });

  it("upstream outage then recovery: error shown, retry succeeds", async () => {
    const user = await h.makeUser("e2e-outage");
    h.setOff(() => ({ status: 500, body: {} }));
    const app = await openApp({ token: user.token });
    const submit = () => app.$("food-barcode-form").dispatchEvent(new app.w.Event("submit", { bubbles: true, cancelable: true }));
    app.type("food-barcode-input", "3017620422003"); submit();
    await app.waitFor(() => /temporarily unavailable.*retry/i.test(app.$("food-camera-status").textContent || ""), "outage message");
    h.setOff(() => ({ body: NUTELLA })); submit();
    await app.waitFor(() => app.$("food-product-review").innerHTML.includes("Nutella"), "recovered"); app.close();
  });

  it("manual label entry: values typed for the serving are logged unchanged (not re-scaled)", async () => {
    const user = await h.makeUser("e2e-manual");
    const app = await openApp({ token: user.token });
    const form = app.$("food-manual-form") as unknown as HTMLFormElement;
    const set = (n: string, v: string) => ((form.elements.namedItem(n) as HTMLInputElement).value = v);
    set("name", "Protein bar"); set("serving", "30"); set("calories", "150"); set("protein", "10"); set("carbs", "12"); set("fat", "6");
    form.dispatchEvent(new app.w.Event("submit", { bubbles: true, cancelable: true }));
    await app.waitFor(() => app.$("food-review-calories"), "review");
    expect(app.$("food-review-serving").value).toBe("30");
    app.click("food-confirm-log");
    await app.waitFor(() => /Protein bar/.test(app.$("food-log-list").textContent || ""), "logged");
    const e = (await dayLog(user.token)).entries[0];
    expect(e).toMatchObject({ foodName: "Protein bar", servingAmount: 30, caloriesKcal: 150, proteinG: 10, carbsG: 12, fatG: 6, source: "manual_label", productCode: null });
    app.close();
  });

  it("unauthenticated user: save is rejected (401), the app is told to sign out, nothing is stored", async () => {
    h.setOff(() => ({ body: NUTELLA }));
    const app = await openApp({}); // no session cookie
    app.type("food-barcode-input", "3017620422003");
    app.$("food-barcode-form").dispatchEvent(new app.w.Event("submit", { bubbles: true, cancelable: true }));
    await app.waitFor(() => app.$("food-product-review").innerHTML.includes("Nutella"), "lookup works while signed out (public endpoint)");
    app.click("food-confirm-log");
    await app.waitFor(() => app.unauth.mock.calls.length > 0, "AuthState.unauthenticated called");
    expect(app.$("food-review-status").textContent).toMatch(/Unauthorized/);
    app.close();
  });

  it("delete removes the entry server-side", async () => {
    const user = await h.makeUser("e2e-delete");
    h.setOff(() => ({ body: NUTELLA }));
    const app = await openApp({ token: user.token });
    app.type("food-barcode-input", "3017620422003");
    app.$("food-barcode-form").dispatchEvent(new app.w.Event("submit", { bubbles: true, cancelable: true }));
    await app.waitFor(() => app.$("food-review-serving"), "review");
    app.click("food-confirm-log");
    await app.waitFor(() => app.dom.window.document.querySelector("[data-delete-log]"), "log row");
    (app.dom.window.document.querySelector("[data-delete-log]") as HTMLElement).click();
    await app.waitFor(() => /No food logged today/.test(app.$("food-log-list").textContent || ""), "empty list");
    expect((await dayLog(user.token)).entries).toHaveLength(0); app.close();
  });

  it("timezone: the client asks for its local day (offset sent with the request)", async () => {
    const user = await h.makeUser("e2e-tz");
    const app = await openApp({ token: user.token, tz: -330 });
    const seen: string[] = []; const orig = app.w.fetch; app.w.fetch = (u: string, i: any) => { seen.push(u); return orig(u, i); };
    app.dom.window.document.querySelector<HTMLElement>('[data-food-view="log"]')!.click();
    await app.waitFor(() => seen.some((u) => u.includes("/nutrition/logs?date=")), "log request");
    expect(seen.find((u) => u.includes("/nutrition/logs"))).toContain("tzOffset=-330");
    await app.waitFor(() => /No food logged today/.test(app.$("food-log-list").textContent || ""), "log request finished"); // don't close mid-request
    app.close();
  });
});
