/* FitOS Diet food intelligence: barcode lookup, OCR-assisted labels, food diary and personalized guidance.
   Product data is community-contributed. OCR and recommendations are estimates and require user review. */
(() => {
  "use strict";
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const apiBase = () => (window.API_BASE_URL || window.API_BASE || "").replace(/\/$/, "");
  const el = id => document.getElementById(id);
  let stream = null, scanTimer = null, mountObserver = null, zxingControls = null, lookupInProgress = false;
  async function call(path, options = {}) {
    const headers = {"Content-Type":"application/json", ...(options.headers || {})};
    const token = localStorage.getItem("accessToken") || "";
    if (token) headers.Authorization = "Bearer " + token;
    const response = await fetch(apiBase() + "/food-scanner" + path, {...options, headers, credentials:"include"});
    const data = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || "Food scanner request failed.");
    return data;
  }
  function mount() {
    const screen = el("screen-diet");
    if (!screen || el("fitos-food-scanner")) return;
    const panel = document.createElement("section");
    panel.id = "fitos-food-scanner";
    panel.className = "card";
    panel.innerHTML = `
      <div class="card-label">FOOD SCANNER & PERSONALIZED NUTRITION</div>
      <p>Scan packaged food, read a nutrition label, or log a meal. Review every value before saving.</p>
      <div class="field"><label for="fos-barcode">Product barcode (EAN / UPC)</label><input id="fos-barcode" inputmode="numeric" autocomplete="off" maxlength="14" placeholder="Scan or enter 8–14 digits"></div>
      <div class="btn-row"><button class="btn btn-mint" id="fos-lookup" type="button">Look up product</button><button class="btn btn-outline" id="fos-camera" type="button">Scan barcode</button></div>
      <div id="fos-camera-wrap" hidden><p id="fos-scan-status" role="status" aria-live="polite">Starting camera…</p><video id="fos-video" autoplay playsinline muted style="width:100%;max-height:260px;background:#111;border-radius:12px"></video><button class="btn btn-outline" id="fos-stop" type="button">Stop camera</button></div>
      <hr>
      <div class="card-label">SCAN A NUTRITION LABEL</div>
      <p>Upload a clear photo of the package nutrition panel. OCR fills draft fields where it can; check them against the label.</p>
      <div class="field"><label for="fos-label-photo">Nutrition label photo</label><input id="fos-label-photo" type="file" accept="image/*" capture="environment"></div>
      <button class="btn btn-outline" id="fos-read-label" type="button">Read nutrition label</button>
      <p id="fos-ocr-status" role="status" aria-live="polite"></p>
      <div id="fos-status" role="status" aria-live="polite"></div><div id="fos-review"></div>
      <hr>
      <div class="card-label">TODAY'S INTAKE</div><div id="fos-totals">Loading…</div><div id="fos-logs"></div>
      <hr>
      <div class="card-label">YOUR NEXT NUTRITION STEP</div><div id="fos-recommendations">Calculating from today's logged food…</div>
      <div class="btn-row"><button class="btn btn-outline" id="fos-nearby" type="button">Find healthy food nearby</button></div>
      <p id="fos-nearby-status" role="status" aria-live="polite"></p>
    `;
    const header = screen.querySelector(".header");
    if (header?.nextSibling) screen.insertBefore(panel, header.nextSibling); else screen.prepend(panel);
    el("fos-lookup").addEventListener("click", lookup);
    el("fos-barcode").addEventListener("keydown", event => { if (event.key === "Enter") lookup(); });
    el("fos-camera").addEventListener("click", startCamera);
    el("fos-stop").addEventListener("click", stopCamera);
    el("fos-read-label").addEventListener("click", readLabel);
    el("fos-nearby").addEventListener("click", findNearby);
    loadLogs();
  }
  function status(message, bad = false) {
    const node = el("fos-status");
    if (node) { node.textContent = message; node.style.color = bad ? "#b42318" : "inherit"; }
  }
  async function lookup() {
    const barcode = el("fos-barcode")?.value.trim() || "";
    if (!/^\d{8,14}$/.test(barcode)) return status("Enter an 8–14 digit barcode.", true);
    if (lookupInProgress) return;
    lookupInProgress = true;
    const button = el("fos-lookup");
    if (button) { button.disabled = true; button.textContent = "Looking up…"; }
    status("Looking up barcode in Open Food Facts…");
    el("fos-review").replaceChildren();
    try {
      const result = await call("/product/" + encodeURIComponent(barcode));
      if (!result?.product) throw new Error("Open Food Facts returned no product data for this barcode.");
      renderProduct(result.product);
      status("Product found. Verify the package details before logging.");
    } catch (error) {
      status((error.message || "Product lookup failed.") + " You can enter values from the package label below.", true);
      renderManual(barcode);
    } finally {
      lookupInProgress = false;
      if (button) { button.disabled = false; button.textContent = "Look up product"; }
    }
  }
  function renderManual(barcode = "", draft = {}) {
    const host = el("fos-review");
    host.innerHTML = `<div class="card"><h3>Review nutrition label</h3>
      <div class="field"><label for="fm-name">Food name</label><input id="fm-name" value="${esc(draft.name || "")}"></div>
      <div class="field"><label for="fm-serving">Serving description</label><input id="fm-serving" value="${esc(draft.serving || "1 serving")}"></div>
      ${[["cal","Calories (kcal)",draft.cal],["pro","Protein (g)",draft.pro],["carb","Carbohydrates (g)",draft.carb],["fat","Fat (g)",draft.fat]].map(([id,label,value]) => `<div class="field"><label for="fm-${id}">${label}</label><input id="fm-${id}" type="number" min="0" step="any" value="${value ?? ""}"></div>`).join("")}
      <div class="field"><label for="fm-count">Servings eaten</label><input id="fm-count" type="number" min="0.1" max="50" step="0.1" value="1"></div>
      <div class="field"><label for="fm-meal">Meal</label><select id="fm-meal"><option>snack</option><option>breakfast</option><option>lunch</option><option>dinner</option></select></div>
      <button class="btn btn-mint" id="fm-save" type="button">Confirm and log</button></div>`;
    el("fm-save").addEventListener("click", () => {
      const value = id => Number(el("fm-" + id).value);
      const name = el("fm-name").value.trim(), values = [value("cal"),value("pro"),value("carb"),value("fat")];
      if (!name || values.some(number => !Number.isFinite(number) || number < 0) || !el("fm-cal").value || !el("fm-pro").value || !el("fm-carb").value || !el("fm-fat").value) return status("Check the food name and enter all four nutrition values from the package. Do not guess.", true);
      const servings = value("count");
      if (!(servings > 0 && servings <= 50)) return status("Servings must be between 0.1 and 50.", true);
      void save({foodName:name, barcode, servingDescription:el("fm-serving").value, servings, caloriesKcal:values[0], proteinG:values[1], carbsG:values[2], fatG:values[3], mealType:el("fm-meal").value, source:"manual-label", verified:true, requestKey:crypto.randomUUID()});
    });
  }
  function renderProduct(product) {
    const p = product || {}, n = p.nutrition || {}, host = el("fos-review");
    host.innerHTML = `<div class="card"><h3>${esc(p.name || "Unnamed product")}</h3><p>${esc(p.brand || "")} · ${esc(p.packageSize || "")}</p>
      <p>Open Food Facts data is community-contributed. Verify it against your package.</p>
      ${p.sourceUrl ? `<p><a href="${esc(p.sourceUrl)}" target="_blank" rel="noopener noreferrer">View source record</a></p>` : ""}
      <div class="field"><label for="pr-name">Food name</label><input id="pr-name" value="${esc(p.name || p.brand || "")}"></div>
      <div class="field"><label for="pr-serving">Serving description</label><input id="pr-serving" value="${esc(p.servingSize || "100 g")}"></div>
      <div class="field"><label for="pr-count">Servings eaten</label><input id="pr-count" type="number" min="0.1" max="50" step="0.1" value="1"></div>
      <div class="field"><label for="pr-meal">Meal</label><select id="pr-meal"><option>snack</option><option>breakfast</option><option>lunch</option><option>dinner</option></select></div>
      <div class="field"><label for="pr-basis">Nutrition basis</label><select id="pr-basis"><option value="100">Values per 100 g/ml</option><option value="serving">Values per serving</option></select></div>
      ${[["caloriesKcal","Calories (kcal)"],["proteinG","Protein (g)"],["carbsG","Carbohydrates (g)"],["fatG","Fat (g)"]].map(([key,label]) => `<div class="field"><label for="pr-${key}">${label}</label><input id="pr-${key}" type="number" min="0" step="any" value="${n[key] ?? ""}"></div>`).join("")}
      <button class="btn btn-mint" id="pr-save" type="button">Confirm and log food</button></div>`;
    el("pr-save").addEventListener("click", () => {
      const keys = ["caloriesKcal","proteinG","carbsG","fatG"], values = keys.map(key => el("pr-" + key).value.trim() === "" ? NaN : Number(el("pr-" + key).value));
      const name = el("pr-name").value.trim(), servings = Number(el("pr-count").value);
      if (!name || values.some(value => !Number.isFinite(value) || value < 0)) return status("Review all nutrition values. Fill missing values from the package instead of guessing.", true);
      if (!(servings > 0 && servings <= 50)) return status("Servings must be between 0.1 and 50.", true);
      if (el("pr-basis").value === "100") {
        const grams = Number(p.servingQuantityG);
        if (!(grams > 0)) return status("The product serving weight is unavailable. Select 'Values per serving' or enter label values manually.", true);
        values.forEach((value, index) => values[index] = value * grams / 100);
      }
      void save({foodName:name, barcode:p.barcode, servingDescription:el("pr-serving").value, servings, caloriesKcal:values[0], proteinG:values[1], carbsG:values[2], fatG:values[3], mealType:el("pr-meal").value, source:"Open Food Facts", verified:true, requestKey:crypto.randomUUID()});
    });
  }
  async function save(body) {
    try { await call("/logs", {method:"POST", body:JSON.stringify(body)}); status("Food logged."); await loadLogs(); }
    catch (error) { status(error.message, true); }
  }
  async function loadLogs() {
    try {
      const data = await call("/logs"), totals = data.totals || {};
      el("fos-totals").textContent = `Calories ${Math.round(totals.caloriesKcal || 0)} kcal · Protein ${Math.round(totals.proteinG || 0)} g · Carbs ${Math.round(totals.carbsG || 0)} g · Fat ${Math.round(totals.fatG || 0)} g`;
      el("fos-logs").innerHTML = (data.logs || []).map(log => `<div class="card"><strong>${esc(log.foodName)}</strong><p>${esc(log.mealType)} · ${esc(log.servings)} serving(s) · ${Math.round(log.caloriesKcal || 0)} kcal · Protein ${Math.round(log.proteinG || 0)} g</p><button class="btn btn-outline" data-fos-delete="${esc(log.id)}" type="button">Remove</button></div>`).join("") || "<p>No food logged today yet.</p>";
      el("fos-logs").querySelectorAll("[data-fos-delete]").forEach(button => button.addEventListener("click", async () => {
        try { await call("/logs/" + encodeURIComponent(button.dataset.fosDelete), {method:"DELETE"}); await loadLogs(); }
        catch (error) { status(error.message, true); }
      }));
      renderRecommendations(totals);
    } catch {
      el("fos-totals").textContent = "Sign in to load your nutrition log.";
      el("fos-recommendations").textContent = "Log in to see personalized guidance based on your saved food diary.";
    }
  }
  function renderRecommendations(totals) {
    const protein = Number(totals.proteinG || 0), calories = Number(totals.caloriesKcal || 0);
    const tips = [];
    if (protein < 20) tips.push("Protein is still low in today's log. Consider a protein-rich option that fits your dietary preference, such as paneer, tofu, dal, beans or curd.");
    else if (protein < 50) tips.push("You're building your protein intake. A balanced meal with dal/beans, tofu/paneer or curd can help you move toward your daily target.");
    else tips.push("Good progress on protein. Keep meals varied and include vegetables, fruit and fibre.");
    if (calories < 500) tips.push("Your logged calories are low so far; this is only a partial diary, not a judgement of your full-day intake.");
    tips.push("These are general suggestions based on foods logged today, not medical advice. Set a personal target with your profile and a qualified professional if needed.");
    el("fos-recommendations").innerHTML = tips.map(tip => `<p>${esc(tip)}</p>`).join("");
  }
  async function readLabel() {
    const file = el("fos-label-photo")?.files?.[0];
    if (!file) { el("fos-ocr-status").textContent = "Choose a clear photo of the nutrition panel first."; return; }
    el("fos-ocr-status").textContent = "Loading OCR and reading label…";
    try {
      if (!window.Tesseract) {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script"); script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
          script.onload = resolve; script.onerror = () => reject(new Error("OCR library could not load. Check your connection and enter the values manually."));
          document.head.appendChild(script);
        });
      }
      const result = await window.Tesseract.recognize(file, "eng");
      const text = result.data.text || "";
      const numberAfter = patterns => {
        for (const pattern of patterns) { const match = text.match(pattern); if (match) return Number(match[1].replace(",", ".")); }
        return "";
      };
      const draft = {
        name: "",
        serving: (text.match(/serving size\s*[:\-]?\s*([^\n]+)/i) || [])[1]?.trim() || "1 serving",
        cal: numberAfter([/(?:energy|calories)\D{0,20}(\d+(?:[.,]\d+)?)/i]),
        pro: numberAfter([/protein\D{0,20}(\d+(?:[.,]\d+)?)/i]),
        carb: numberAfter([/(?:total carbohydrate|carbohydrate|carbs)\D{0,20}(\d+(?:[.,]\d+)?)/i]),
        fat: numberAfter([/(?:total fat|fat)\D{0,20}(\d+(?:[.,]\d+)?)/i])
      };
      renderManual("", draft);
      el("fos-ocr-status").textContent = "OCR draft created. Check every value against the photo; OCR can misread decimals and units.";
      status("Review the OCR results before saving. Nothing was logged automatically.");
    } catch (error) { el("fos-ocr-status").textContent = error.message || "Could not read the image. Enter values manually."; }
  }
  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) return status("Camera access is unavailable here. Enter the barcode manually.", true);
    const wrap = el("fos-camera-wrap"), video = el("fos-video"), scanStatus = el("fos-scan-status");
    wrap.hidden = false;
    scanStatus.textContent = "Starting camera…";
    try {
      if ("BarcodeDetector" in window) {
        const detector = new BarcodeDetector({formats:["ean_8","ean_13","upc_a","upc_e","qr_code"]});
        stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}}, audio:false});
        video.srcObject = stream;
        await video.play();
        scanStatus.textContent = "Scanning… Hold the barcode steady inside the camera view.";
        const scan = async () => {
          if (!stream) return;
          try {
            const codes = await detector.detect(video);
            let barcode = codes.find(code => ["ean_8","ean_13","upc_a","upc_e"].includes(code.format) && /^\d{8,14}$/.test(code.rawValue))?.rawValue;
            const qr = codes.find(code => code.format === "qr_code")?.rawValue;
            if (!barcode && qr) {
              if (/^\d{8,14}$/.test(qr)) barcode = qr;
              else try { const url = new URL(qr); const match = url.hostname === "world.openfoodfacts.org" && url.pathname.match(/^\/product\/(\d{8,14})\/?$/); if (match) barcode = match[1]; } catch {}
            }
            if (barcode) {
              el("fos-barcode").value = barcode;
              scanStatus.textContent = "Barcode detected. Looking up product…";
              stopCamera();
              await lookup();
              return;
            }
          } catch {}
          scanTimer = setTimeout(scan, 250);
        };
        void scan();
      } else {
        scanStatus.textContent = "Loading barcode scanner…";
        if (!window.ZXingBrowser) {
          await new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = "https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/index.min.js";
            script.onload = resolve;
            script.onerror = () => reject(new Error("Barcode scanner could not load. Check your connection or enter the barcode manually."));
            document.head.appendChild(script);
          });
        }
        if (!window.ZXingBrowser?.BrowserMultiFormatReader) throw new Error("Live barcode scanning is not supported in this browser. Enter the barcode manually.");
        const reader = new window.ZXingBrowser.BrowserMultiFormatReader();
        scanStatus.textContent = "Scanning… Hold the barcode steady inside the camera view.";
        zxingControls = await reader.decodeFromVideoDevice(undefined, video, async (result) => {
          if (!result || lookupInProgress || !stream) return;
          const raw = result.getText?.() || "";
          let barcode = /^\d{8,14}$/.test(raw) ? raw : "";
          if (!barcode) {
            try {
              const url = new URL(raw);
              barcode = url.hostname === "world.openfoodfacts.org" ? (url.pathname.match(/^\/product\/(\d{8,14})\/?$/) || [])[1] || "" : "";
            } catch {}
          }
          if (!barcode) return;
          el("fos-barcode").value = barcode;
          scanStatus.textContent = "Barcode detected. Looking up product…";
          stopCamera();
          await lookup();
        });
        stream = video.srcObject;
      }
    } catch (error) {
      stopCamera();
      status(error?.message || "Camera permission denied or camera unavailable. Enter barcode manually.", true);
    }
  }
  function stopCamera() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
    if (zxingControls) { try { zxingControls.stop(); } catch {} }
    zxingControls = null;
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
    const wrap = el("fos-camera-wrap"); if (wrap) wrap.hidden = true;
    const video = el("fos-video"); if (video) video.srcObject = null;
  }
  async function findNearby() {
    const feedback = el("fos-nearby-status");
    feedback.textContent = "Checking the existing FitOS nearby-food feature…";
    try {
      if (typeof window.findHealthyFood === "function") {
        await window.findHealthyFood();
        feedback.textContent = "Nearby-food search requested. Review the results above.";
      } else {
        feedback.textContent = "Nearby restaurant search is not connected to a callable API on this build yet. No restaurants have been invented. The scanner and nutrition diary work independently.";
      }
    } catch (error) { feedback.textContent = error.message || "Nearby search failed."; }
  }
  function init() {
    mount();
    if (!mountObserver) {
      mountObserver = new MutationObserver(() => {
        if (el("screen-diet")?.classList.contains("active")) mount();
        else if (stream) stopCamera();
      });
      mountObserver.observe(document.documentElement, {childList:true, subtree:true, attributes:true, attributeFilter:["class"]});
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, {once:true}); else init();
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopCamera(); });
  window.addEventListener("pagehide", stopCamera);
})();