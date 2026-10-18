import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { barcodeFrame, blankFrame } from "./helpers/barcodeImages";

const req = createRequire(__filename);
const frontend = path.join(__dirname, "../../../frontend");
const B = req(path.join(frontend, "barcode-scanner.js"));
const ZXing = req("@zxing/library");

describe("barcode helpers", () => {
  it("validates GTIN check digits", () => {
    expect(B.gtinCheckDigitOk("3017620422003")).toBe(true);
    expect(B.gtinCheckDigitOk("3017620422004")).toBe(false);
    expect(B.gtinCheckDigitOk("036000291452")).toBe(true);
    expect(B.gtinCheckDigitOk("96385074")).toBe(true);
    expect(B.gtinCheckDigitOk("12345")).toBe(false);
  });
  it("expands UPC-E to UPC-A (published example 04252614 → 042100005264)", () => {
    expect(B.expandUpcE("04252614")).toBe("042100005264");
    expect(B.normalizeScan("04252614", "upc_e")).toBe("042100005264");
    expect(B.normalizeScan("04252615", "upc_e")).toBeNull();
  });
  it("accepts Open Food Facts QR URLs and rejects junk / misreads", () => {
    expect(B.normalizeScan("https://world.openfoodfacts.org/product/3017620422003/nutella")).toBe("3017620422003");
    expect(B.normalizeScan("https://evil.example/product/3017620422003")).toBeNull();
    expect(B.normalizeScan("hello")).toBeNull();
    expect(B.normalizeScan("3017620422009")).toBeNull();
  });
  it("describes camera errors for users", () => {
    expect(B.describeCameraError({ name: "NotAllowedError" })).toMatch(/permission was denied/);
    expect(B.describeCameraError({ name: "NotFoundError" })).toMatch(/No usable camera/);
    expect(B.describeCameraError({ name: "NotReadableError" })).toMatch(/busy/);
    expect(B.describeCameraError({ name: "X" }, { secure: false })).toMatch(/HTTPS/);
  });
});

describe("ZXing decoding of real rendered barcodes", () => {
  const cases: Array<[string, string, string, string, object?]> = [
    ["EAN-13", "ean13", "400638133393", "4006381333931"],
    ["EAN-13 (Nutella)", "ean13", "301762042200", "3017620422003"],
    ["UPC-A", "upca", "03600029145", "036000291452"],
    ["EAN-8", "ean8", "9638507", "96385074"],
    ["EAN-13 small/far (scale 2)", "ean13", "400638133393", "4006381333931", { scale: 2 }],
    ["EAN-13 rotated 90°", "ean13", "400638133393", "4006381333931", { rotate: "R" }],
    ["EAN-13 heavy sensor noise", "ean13", "400638133393", "4006381333931", { noise: 40 }],
  ];
  for (const [label, bcid, text, expected, opts] of cases) {
    it(`decodes ${label}`, async () => {
      const frame = await barcodeFrame(bcid, text, opts as any);
      const result = B.decodeFrameZXing(ZXing, frame);
      expect(result, "decoder returned nothing").not.toBeNull();
      expect(B.normalizeScan(result.rawValue, result.format)).toBe(expected);
    });
  }
  // bwip-js UPC-E renders were not decodable by the vendored ZXing build, so camera decoding of UPC-E is UNVERIFIED.
  it.todo("decodes UPC-E from a real image (unverified; expansion logic itself is covered above)");
  it("returns null (no throw) for a frame with no barcode", () => {
    expect(B.decodeFrameZXing(ZXing, blankFrame())).toBeNull();
  });
});

// ---- scanner orchestration with a fake camera ----
function fakeEnv(overrides: Record<string, unknown> = {}) {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] };
  const video: any = { readyState: 4, videoWidth: 640, videoHeight: 480, srcObject: null, muted: false, play: vi.fn(async () => {}), pause: vi.fn(), setAttribute: vi.fn() };
  const win: any = { isSecureContext: true };
  const navigator = { mediaDevices: { getUserMedia: vi.fn(async () => stream) } };
  const timers: Array<() => void> = [];
  const base = { window: win, document: {}, video, navigator, setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimeout: vi.fn(), BarcodeDetector: null };
  const runTicks = async (n: number) => { for (let i = 0; i < n; i++) { const t = timers.shift(); if (!t) return; await (t as any)(); await Promise.resolve(); } };
  return { track, stream, video, win, navigator, timers, runTicks, opts: { ...base, ...overrides } as any };
}

describe("scanner engine selection and lifecycle", () => {
  it("uses the native BarcodeDetector when it supports retail formats", async () => {
    const detect = vi.fn(async () => [{ rawValue: "4006381333931", format: "ean_13" }]);
    const Native: any = vi.fn(function () { return { detect }; }); Native.getSupportedFormats = async () => ["ean_13", "ean_8", "upc_a", "upc_e", "qr_code"];
    const e = fakeEnv({ BarcodeDetector: Native }); const onDetected = vi.fn();
    const s = B.createScanner({ ...e.opts, onDetected });
    await s.start(); expect(s.engine.name).toBe("native");
    await e.runTicks(1);
    expect(onDetected).toHaveBeenCalledWith("4006381333931");
    expect(e.track.stop).toHaveBeenCalled(); expect(e.video.srcObject).toBeNull(); // camera released after a hit
  });
  it("falls back to ZXing when BarcodeDetector does not exist (Safari/Firefox)", async () => {
    const frame = await barcodeFrame("ean13", "400638133393");
    const e = fakeEnv({ loadZXing: async () => ZXing, grabFrame: () => frame }); const onDetected = vi.fn();
    const s = B.createScanner({ ...e.opts, onDetected });
    await s.start(); expect(s.engine.name).toBe("zxing");
    await e.runTicks(1);
    expect(onDetected).toHaveBeenCalledWith("4006381333931");
  });
  it("falls back to ZXing when BarcodeDetector exists but cannot read EAN/UPC (e.g. QR only)", async () => {
    const Native: any = vi.fn(); Native.getSupportedFormats = async () => ["qr_code"];
    const e = fakeEnv({ BarcodeDetector: Native, loadZXing: async () => ZXing, grabFrame: () => blankFrame() });
    const s = B.createScanner({ ...e.opts, onDetected: vi.fn() });
    await s.start(); expect(s.engine.name).toBe("zxing"); expect(Native).not.toHaveBeenCalled();
  });
  it("switches from a failing native detector to ZXing instead of hanging", async () => {
    const Native: any = vi.fn(function () { return { detect: async () => { throw new Error("boom"); } }; }); Native.getSupportedFormats = async () => ["ean_13", "ean_8", "upc_a"];
    const frame = await barcodeFrame("ean13", "400638133393"); const onDetected = vi.fn();
    const e = fakeEnv({ BarcodeDetector: Native, loadZXing: async () => ZXing, grabFrame: () => frame });
    const s = B.createScanner({ ...e.opts, onDetected });
    await s.start(); expect(s.engine.name).toBe("native");
    await e.runTicks(6);
    expect(s.engine?.name ?? "zxing").toBe("zxing");
    expect(onDetected).toHaveBeenCalledWith("4006381333931");
  });
  it("ignores checksum-invalid reads and keeps scanning", async () => {
    const bad = [{ rawValue: "4006381333932", format: "ean_13" }];
    const detect = vi.fn(async () => bad);
    const Native: any = vi.fn(function () { return { detect }; }); Native.getSupportedFormats = async () => ["ean_13", "ean_8"];
    const e = fakeEnv({ BarcodeDetector: Native }); const onDetected = vi.fn();
    const s = B.createScanner({ ...e.opts, onDetected });
    await s.start(); await e.runTicks(3);
    expect(onDetected).not.toHaveBeenCalled(); expect(e.timers.length).toBe(1); // still polling
    s.stop();
  });
  it("reports a denied camera permission and releases everything", async () => {
    const e = fakeEnv(); e.navigator.mediaDevices.getUserMedia = vi.fn(async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); });
    const s = B.createScanner({ ...e.opts, onDetected: vi.fn() });
    await expect(s.start()).rejects.toThrow(/permission was denied/); expect(s.running).toBe(false);
  });
  it("reports no camera / insecure context / unsupported browser", async () => {
    const e1 = fakeEnv(); e1.navigator.mediaDevices.getUserMedia = vi.fn(async () => { throw Object.assign(new Error("x"), { name: "NotFoundError" }); });
    await expect(B.createScanner({ ...e1.opts, onDetected: vi.fn() }).start()).rejects.toThrow(/No usable camera/);
    const e2 = fakeEnv(); e2.win.isSecureContext = false;
    await expect(B.createScanner({ ...e2.opts, onDetected: vi.fn() }).start()).rejects.toThrow(/HTTPS/);
    const e3 = fakeEnv({ navigator: {} });
    await expect(B.createScanner({ ...e3.opts, onDetected: vi.fn() }).start()).rejects.toThrow(/not available/);
  });
  it("surfaces a ZXing load failure and stops the camera", async () => {
    const e = fakeEnv({ loadZXing: async () => { throw new Error("The barcode scanner component could not load."); } });
    await expect(B.createScanner({ ...e.opts, onDetected: vi.fn() }).start()).rejects.toThrow(/could not load/);
    expect(e.track.stop).toHaveBeenCalled();
  });
  it("releases the stream if stopped while the permission prompt is still open", async () => {
    const e = fakeEnv(); let release!: (s: unknown) => void;
    e.navigator.mediaDevices.getUserMedia = vi.fn(() => new Promise((r) => { release = r; })) as any;
    const s = B.createScanner({ ...e.opts, onDetected: vi.fn() });
    const started = s.start(); s.stop(); release(e.stream); await started;
    expect(e.track.stop).toHaveBeenCalled();
  });
});
