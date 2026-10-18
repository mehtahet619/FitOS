/* FitOS barcode scanner: native BarcodeDetector where it really supports retail codes, otherwise a bundled
   ZXing decoder (vendor/zxing-library-*.min.js, Apache-2.0) running on camera frames. Loads as a plain
   <script> (window.FitOSBarcode) and as a CommonJS module for tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FitOSBarcode = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const RETAIL_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"];
  const ZXING_SRC = "https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js";

  function gtinCheckDigitOk(code) {
    if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
    const digits = code.split("").map(Number);
    const check = digits.pop();
    let sum = 0;
    for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += digits[i] * w;
    return (10 - (sum % 10)) % 10 === check;
  }
  // UPC-E is a zero-suppressed UPC-A; Open Food Facts indexes the expanded form.
  function expandUpcE(code) {
    if (!/^\d{8}$/.test(code)) return null;
    const ns = code[0], d = code.slice(1, 7).split(""), check = code[7];
    if (ns !== "0" && ns !== "1") return null;
    const last = d[5];
    let body;
    if ("012".includes(last)) body = d[0] + d[1] + last + "0000" + d[2] + d[3] + d[4];
    else if (last === "3") body = d[0] + d[1] + d[2] + "00000" + d[3] + d[4];
    else if (last === "4") body = d[0] + d[1] + d[2] + d[3] + "00000" + d[4];
    else body = d[0] + d[1] + d[2] + d[3] + d[4] + "0000" + last;
    return ns + body + check;
  }
  // Accepts a raw decoder value (digits or an Open Food Facts product URL) and returns a checksum-valid
  // 8/12/13/14 digit code, or null. Misreads are rejected here instead of reaching the API.
  function normalizeScan(rawValue, format) {
    let raw = String(rawValue || "").trim();
    const url = raw.match(/^https:\/\/(?:[a-z0-9-]+\.)?openfoodfacts\.org\/(?:[a-z-]+\/)?product\/(\d{8,14})(?:\/|$)/i);
    if (url) raw = url[1];
    if (!/^\d+$/.test(raw)) return null;
    let code = raw;
    if (String(format || "").toLowerCase() === "upc_e" && code.length === 8) {
      code = expandUpcE(code); // UPC-E shares its check digit with the expanded UPC-A, so validate that form below
      if (!code) return null;
    }
    return gtinCheckDigitOk(code) ? code : null;
  }
  function describeCameraError(error, env) {
    const name = error && error.name;
    if (env && env.secure === false) return "Camera access needs a secure (HTTPS) connection. Enter the barcode manually.";
    if (name === "NotAllowedError" || name === "SecurityError") return "Camera permission was denied. Allow camera access in your browser settings, or enter the barcode manually.";
    if (name === "NotFoundError" || name === "OverconstrainedError") return "No usable camera was found. Enter the barcode manually.";
    if (name === "NotReadableError" || name === "AbortError") return "The camera is busy or unavailable (another app may be using it). Close it and try again, or enter the barcode manually.";
    return (error && error.message) || "Could not open the camera. Enter the barcode manually.";
  }
  function luminance(rgba, width, height) {
    const out = new Uint8ClampedArray(width * height);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114) / 1000;
    return out;
  }
  function rotate90(lum, width, height) {
    const out = new Uint8ClampedArray(lum.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out[x * height + (height - 1 - y)] = lum[y * width + x];
    return out;
  }
  // Decode one RGBA frame with ZXing. Returns { rawValue, format } or null when no code is visible.
  // Tries the frame upright, then rotated 90° (a portrait-held phone shows vertical bars).
  function decodeFrameZXing(ZXing, frame, reader) {
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8, ZXing.BarcodeFormat.UPC_A, ZXing.BarcodeFormat.UPC_E]);
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    const r = reader || new ZXing.MultiFormatReader();
    r.setHints(hints);
    const names = { [ZXing.BarcodeFormat.EAN_13]: "ean_13", [ZXing.BarcodeFormat.EAN_8]: "ean_8", [ZXing.BarcodeFormat.UPC_A]: "upc_a", [ZXing.BarcodeFormat.UPC_E]: "upc_e" };
    // The vendored build is minified, so error.name is mangled: use instanceof, not names.
    const isMiss = (e) => e instanceof ZXing.NotFoundException || e instanceof ZXing.ChecksumException || e instanceof ZXing.FormatException;
    const upright = luminance(frame.data, frame.width, frame.height);
    for (let i = 0; i < 2; i++) {
      const [lum, w, h] = i === 0 ? [upright, frame.width, frame.height] : [rotate90(upright, frame.width, frame.height), frame.height, frame.width];
      try {
        const result = r.decode(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.RGBLuminanceSource(lum, w, h))));
        return { rawValue: result.getText(), format: names[result.getBarcodeFormat()] || "" };
      } catch (error) {
        if (!isMiss(error)) throw error;
      }
    }
    return null;
  }
  function loadScript(src, doc) {
    return new Promise((resolve, reject) => {
      const el = doc.createElement("script");
      el.src = src; el.async = true;
      el.onload = resolve;
      el.onerror = () => reject(new Error("The barcode scanner component could not load. Check your connection or enter the barcode manually."));
      doc.head.appendChild(el);
    });
  }
  function defaultGrabFrame(video, doc) {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return null;
    const scale = Math.min(1, 960 / w);
    const canvas = doc.createElement("canvas");
    canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { data: img.data, width: img.width, height: img.height };
  }

  /* createScanner(options) -> { start(), stop(), engine }
     Everything environment-specific is injectable so the whole flow can be tested without a camera. */
  function createScanner(options) {
    const win = options.window || (typeof window !== "undefined" ? window : {});
    const doc = options.document || win.document;
    const video = options.video;
    const onDetected = options.onDetected;
    const onStatus = options.onStatus || function () {};
    const intervalMs = options.intervalMs || 200;
    const setT = options.setTimeout || ((fn, ms) => win.setTimeout(fn, ms));
    const clearT = options.clearTimeout || ((id) => win.clearTimeout(id));
    const getZXing = options.loadZXing || (async () => {
      if (!win.ZXing) await loadScript(options.zxingSrc || ZXING_SRC, doc);
      if (!win.ZXing || !win.ZXing.MultiFormatReader) throw new Error("Live barcode scanning is not supported in this browser. Enter the barcode manually.");
      return win.ZXing;
    });
    const grabFrame = options.grabFrame || ((v) => defaultGrabFrame(v, doc));
    let stream = null, timer = null, running = false, engine = null;
    const scanner = { get engine() { return engine; }, get running() { return running; } };

    async function pickEngine() {
      const Native = options.BarcodeDetector !== undefined ? options.BarcodeDetector : win.BarcodeDetector;
      if (Native) {
        try {
          // Some browsers expose BarcodeDetector but only support QR/other formats (or none at all).
          const supported = typeof Native.getSupportedFormats === "function" ? await Native.getSupportedFormats() : RETAIL_FORMATS;
          const formats = RETAIL_FORMATS.filter((f) => supported.includes(f));
          if (formats.length >= 2) return { name: "native", detector: new Native({ formats }) };
        } catch (_) { /* fall through to ZXing */ }
      }
      const ZXing = await getZXing();
      return { name: "zxing", ZXing, reader: new ZXing.MultiFormatReader() };
    }

    scanner.start = async function () {
      if (running) return;
      const nav = options.navigator || win.navigator;
      if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== "function") {
        throw Object.assign(new Error("Camera access is not available in this browser or page. Enter the barcode manually."), { name: "CameraUnsupported" });
      }
      if (win.isSecureContext === false) throw Object.assign(new Error(describeCameraError(null, { secure: false })), { name: "InsecureContext" });
      running = true;
      onStatus("Requesting camera…");
      try {
        stream = await nav.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        if (!running) { stream.getTracks().forEach((t) => t.stop()); stream = null; return; } // stopped while the permission prompt was open
        video.srcObject = stream;
        if (typeof video.setAttribute === "function") video.setAttribute("playsinline", "true");
        video.muted = true;
        await video.play();
        engine = await pickEngine();
        if (!running) return;
      } catch (error) {
        scanner.stop();
        throw Object.assign(new Error(describeCameraError(error, { secure: win.isSecureContext !== false })), { name: error && error.name, cause: error });
      }
      onStatus(engine.name === "native" ? "Camera is on. Hold the barcode inside the frame." : "Camera is on (compatibility scanner). Hold the barcode steady inside the frame.");
      let nativeFailures = 0;
      const tick = async () => {
        timer = null;
        if (!running) return;
        try {
          let hit = null;
          if (engine.name === "native") {
            const found = await engine.detector.detect(video);
            for (const item of found) { const code = normalizeScan(item.rawValue, item.format); if (code) { hit = code; break; } }
            nativeFailures = 0;
          } else {
            const frame = video.readyState >= 2 ? grabFrame(video) : null;
            const result = frame ? decodeFrameZXing(engine.ZXing, frame, engine.reader) : null;
            if (result) hit = normalizeScan(result.rawValue, result.format);
          }
          if (hit && running) { scanner.stop(); onDetected(hit); return; }
        } catch (error) {
          if (engine.name === "native" && ++nativeFailures >= 3) {
            // Native detector keeps throwing (e.g. unsupported on this device): switch engines instead of hanging silently.
            try { const ZXing = await getZXing(); engine = { name: "zxing", ZXing, reader: new ZXing.MultiFormatReader() }; nativeFailures = 0; onStatus("Switched to compatibility scanner."); }
            catch (loadError) { scanner.stop(); onStatus(loadError.message, true); return; }
          }
        }
        if (running) timer = setT(tick, intervalMs);
      };
      timer = setT(tick, intervalMs);
    };
    scanner.stop = function () {
      running = false;
      if (timer !== null) clearT(timer);
      timer = null;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
      if (video) { try { if (typeof video.pause === "function") video.pause(); } catch (_) {} video.srcObject = null; }
    };
    return scanner;
  }

  return { createScanner, normalizeScan, gtinCheckDigitOk, expandUpcE, decodeFrameZXing, describeCameraError, luminance };
});
