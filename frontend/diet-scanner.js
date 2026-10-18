/* FitOS Diet Scanner: Open Food Facts barcode lookup + user-confirmed food diary. */
(function () {
  "use strict";
  const API = window.Api;
  if (!API) return;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  let stream = null;
  let selectedProduct = null;
  let activeScanner = null;

  function stopCamera() {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
    if (activeScanner && typeof activeScanner.reset === "function") activeScanner.reset();
    activeScanner = null;
  }
  function shell() {
    const el = document.getElementById("diet-content");
    if (!el) return;
    stopCamera();
    el.innerHTML = `
      <section class="card diet-scan-card">
        <div class="card-label">🥗 DAILY NUTRITION</div>
        <p class="muted">Track meals using product data or enter nutrition from your package label. Always verify serving size before logging.</p>
        <div class="diet-scan-actions">
          <button class="btn btn-primary" id="diet-open-scanner" type="button">▦ Scan barcode / QR</button>
          <button class="btn btn-outline" id="diet-manual-open" type="button">＋ Manual food entry</button>
        </div>
        <label class="field-label" for="diet-barcode">Or enter barcode</label>
        <div class="diet-inline"><input id="diet-barcode" inputmode="numeric" autocomplete="off" placeholder="EAN / UPC digits" maxlength="14"><button class="btn btn-outline" id="diet-lookup" type="button">Look up</button></div>
        <div id="diet-scan-panel" aria-live="polite"></div>
      </section>
      <section class="card">
        <div class="card-label">TODAY'S NUTRITION</div>
        <div class="diet-totals" id="diet-totals"><span>Loading diary…</span></div>
        <div id="diet-log-list"></div>
      </section>
      <section class="card">
        <div class="card-label">📍 HEALTHY FOOD NEAR YOU</div>
        <p class="muted">Nearby listings use the configured real maps provider. Share location only when you choose to search.</p>
        <button class="btn btn-outline" id="diet-nearby" type="button">Find nearby food</button>
        <div id="diet-nearby-panel" aria-live="polite"></div>
      </section>
      <p class="muted diet-source-note">Packaged-food data: Open Food Facts (community contributed). Nutrition may be incomplete or inaccurate. This is general wellness tracking, not medical advice.</p>`;
    document.getElementById("diet-open-scanner").addEventListener("click", openScanner);
    document.getElementById("diet-manual-open").addEventListener("click", () => renderReview(null));
    document.getElementById("diet-lookup").addEventListener("click", () => lookup(document.getElementById("diet-barcode").value));
    document.getElementById("diet-barcode").addEventListener("keydown", (e) => { if (e.key === "Enter") lookup(e.currentTarget.value); });
    document.getElementById("diet-nearby").addEventListener("click", findNearby);
    void loadDiary();
  }
  async function lookup(raw) {
    const code = String(raw || "").trim();
    const panel = document.getElementById("diet-scan-panel");
    if (!/^\d{8,14}$/.test(code)) { panel.innerHTML = '<div class="banner banner-error">Enter a valid 8–14 digit EAN/UPC barcode.</div>'; return; }
    panel.innerHTML = '<div class="empty-state"><span class="spinner"></span> Checking Open Food Facts…</div>';
    try {
      const product = await API.get("/food-scanner/product/" + encodeURIComponent(code));
      selectedProduct = product;
      renderReview(product);
    } catch (error) {
      panel.innerHTML = `<div class="banner banner-info">${esc(error.message || "Product lookup failed.")} Nutrition can be entered manually from the package label.</div><button class="btn btn-outline" id="diet-manual-after-fail" type="button">Enter manually</button>`;
      document.getElementById("diet-manual-after-fail").addEventListener("click", () => renderReview(null, code));
    }
  }
  async function openScanner() {
    const panel = document.getElementById("diet-scan-panel");
    panel.innerHTML = `<div class="camera-panel diet-camera"><video id="diet-scan-video" autoplay playsinline muted></video><div class="camera-feedback" style="display:block">Point at a barcode or QR code. Camera runs only while this panel is open.</div></div><div class="diet-scan-actions"><button class="btn btn-outline" id="diet-camera-close" type="button">Close camera</button></div><div id="diet-camera-status" class="muted"></div>`;
    document.getElementById("diet-camera-close").addEventListener("click", () => { stopCamera(); panel.innerHTML = ""; });
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access is not supported in this browser. Enter the barcode manually.");
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      const video = document.getElementById("diet-scan-video");
      if (!video) { stopCamera(); return; }
      video.srcObject = stream;
      if ("BarcodeDetector" in window) {
        let detector;
        try { detector = new BarcodeDetector({ formats: ["ean_13","ean_8","upc_a","upc_e","qr_code"] }); }
        catch { detector = new BarcodeDetector(); }
        activeScanner = { reset: stopCamera };
        const tick = async () => {
          if (!stream || !document.getElementById("diet-scan-video")) return;
          try {
            const codes = await detector.detect(video);
            const found = codes.find((item) => ["ean_13","ean_8","upc_a","upc_e","qr_code"].includes(item.format));
            if (found) {
              const value = found.rawValue || "";
              if (/^\d{8,14}$/.test(value)) { stopCamera(); document.getElementById("diet-barcode").value = value; await lookup(value); return; }
              const barcode = parseOpenFoodFactsQr(value);
              if (barcode) { stopCamera(); document.getElementById("diet-barcode").value = barcode; await lookup(barcode); return; }
              const status = document.getElementById("diet-camera-status");
              if (status) status.textContent = "QR detected, but it is not a recognized Open Food Facts product link. Enter the barcode printed on the package.";
            }
          } catch { /* Some frames cannot be decoded while the camera initializes. */ }
          if (stream) window.setTimeout(tick, 300);
        };
        video.addEventListener("loadeddata", tick, { once: true });
      } else {
        // jsQR is already loaded by FitOS. It supports QR; native BarcodeDetector is needed for EAN/UPC.
        const status = document.getElementById("diet-camera-status");
        if (status) status.textContent = "This browser cannot scan EAN/UPC natively. Use manual barcode entry or a QR code supported by your camera.";
        const canvas = document.createElement("canvas"), context = canvas.getContext("2d");
        const tick = () => {
          if (!stream || !document.getElementById("diet-scan-video")) return;
          if (video.readyState >= 2) {
            canvas.width = video.videoWidth; canvas.height = video.videoHeight;
            context.drawImage(video,0,0,canvas.width,canvas.height);
            if (typeof window.jsQR === "function") {
              const decoded = window.jsQR(context.getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height);
              const barcode = decoded && parseOpenFoodFactsQr(decoded.data);
              if (barcode) { stopCamera(); document.getElementById("diet-barcode").value=barcode; void lookup(barcode); return; }
            }
          }
          window.setTimeout(tick,350);
        };
        video.addEventListener("loadeddata",tick,{once:true});
      }
    } catch (error) {
      stopCamera();
      panel.innerHTML = `<div class="banner banner-error">${esc(error.message || "Could not open camera.")}</div>`;
    }
  }
  function parseOpenFoodFactsQr(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || !["world.openfoodfacts.org","openfoodfacts.org"].includes(url.hostname.toLowerCase())) return null;
      const match = url.pathname.match(/^\/product\/(\d{8,14})\/?$/);
      return match ? match[1] : null;
    } catch { return null; }
  }
  function renderReview(product, barcode = "") {
    const panel = document.getElementById("diet-scan-panel");
    const n = product?.nutrientsPer100g || {};
    panel.innerHTML = `
      <div class="diet-product-review">
        <div class="card-label">${product ? "REVIEW PRODUCT" : "MANUAL NUTRITION ENTRY"}</div>
        ${product?.imageUrl ? `<img class="diet-product-image" src="${esc(product.imageUrl)}" alt="Product package" loading="lazy" referrerpolicy="no-referrer">` : ""}
        ${product?.note ? `<p class="muted">${esc(product.note)}</p>` : '<p class="muted">Enter nutrient values per 100 g from the nutrition label. Unknown values can be left blank; nothing is guessed.</p>'}
        <label class="field-label">Food name<input id="diet-food-name" maxlength="160" value="${esc(product?.name || "")}" placeholder="Product or food name" required></label>
        <label class="field-label">Brand (optional)<input id="diet-food-brand" maxlength="160" value="${esc(product?.brand || "")}" placeholder="Brand"></label>
        <label class="field-label">Serving eaten (grams)<input id="diet-food-serving" type="number" min="1" max="5000" step="1" value="100" required></label>
        <p class="muted">Nutrition values below are per 100 g, not per serving.</p>
        <div class="diet-nutrient-grid">
          ${nutrientField("calories","Calories (kcal)",n.calories)}
          ${nutrientField("proteinG","Protein (g)",n.proteinG)}
          ${nutrientField("carbsG","Carbs (g)",n.carbsG)}
          ${nutrientField("fatG","Fat (g)",n.fatG)}
          ${nutrientField("fiberG","Fibre (g)",n.fiberG)}
          ${nutrientField("sugarG","Sugar (g)",n.sugarG)}
          ${nutrientField("sodiumMg","Sodium (mg)",n.sodiumMg)}
        </div>
        <div id="diet-preview" class="banner banner-info">Review values and serving size before adding.</div>
        <div class="diet-scan-actions"><button class="btn btn-primary" id="diet-save-food" type="button">Confirm & add to diary</button><button class="btn btn-outline" id="diet-review-cancel" type="button">Cancel</button></div>
      </div>`;
    const fields = ["calories","proteinG","carbsG","fatG","fiberG","sugarG","sodiumMg"];
    const updatePreview = () => {
      const grams = Number(document.getElementById("diet-food-serving").value);
      const vals = fields.slice(0,6).map((key) => {
        const value = document.getElementById("diet-n-" + key).value;
        return value === "" ? null : Number(value) * grams / 100;
      });
      document.getElementById("diet-preview").textContent = `For ${grams || "?"} g: ${vals[0] == null ? "calories unknown" : vals[0].toFixed(0)+" kcal"} · Protein ${vals[1] == null ? "—" : vals[1].toFixed(1)+" g"} · Carbs ${vals[2] == null ? "—" : vals[2].toFixed(1)+" g"} · Fat ${vals[3] == null ? "—" : vals[3].toFixed(1)+" g"}. Values are estimates from the entered label/database.`;
    };
    panel.querySelectorAll("input").forEach((input) => input.addEventListener("input",updatePreview));
    updatePreview();
    document.getElementById("diet-review-cancel").addEventListener("click", () => { panel.innerHTML = ""; selectedProduct = null; });
    document.getElementById("diet-save-food").addEventListener("click", async () => {
      const button = document.getElementById("diet-save-food");
      const name = document.getElementById("diet-food-name").value.trim();
      const servingGrams = Number(document.getElementById("diet-food-serving").value);
      if (!name || !Number.isFinite(servingGrams) || servingGrams <= 0 || servingGrams > 5000) { alert("Enter a food name and valid serving size."); return; }
      const body = { name, brand:document.getElementById("diet-food-brand").value.trim(), barcode:product?.barcode || barcode || "", servingGrams, source:product?.source || "manual_label", sourceUrl:product?.sourceUrl || "", verificationStatus:product ? "user_confirmed_off_database" : "user_entered_label" };
      for (const key of fields) {
        const value = document.getElementById("diet-n-" + key).value;
        body[key] = value === "" ? null : Number(value);
      }
      button.disabled = true; button.textContent = "Saving…";
      try { await API.post("/food-scanner/logs",body); selectedProduct = null; panel.innerHTML = '<div class="banner banner-info">Food added to today’s diary.</div>'; await loadDiary(); }
      catch (error) { button.disabled = false; button.textContent = "Confirm & add to diary"; panel.insertAdjacentHTML("afterbegin",`<div class="banner banner-error">${esc(error.message || "Could not save food.")}</div>`); }
    });
  }
  function nutrientField(key,label,value) {
    return `<label class="field-label">${label}<input id="diet-n-${key}" type="number" min="0" step="any" value="${value == null ? "" : esc(value)}" placeholder="Unknown"></label>`;
  }
  async function loadDiary() {
    try {
      const data = await API.get("/food-scanner/logs/today");
      const t = data.totals || {};
      document.getElementById("diet-totals").innerHTML = [
        ["Calories",t.calories,"kcal"],["Protein",t.proteinG,"g"],["Carbs",t.carbsG,"g"],["Fat",t.fatG,"g"]
      ].map(([label,value,unit]) => `<div class="diet-total"><strong>${Number(value || 0).toFixed(label==="Calories"?0:1)}</strong><span>${label} · ${unit}</span></div>`).join("");
      const list = document.getElementById("diet-log-list");
      list.innerHTML = data.logs.length ? data.logs.map((log) => {
        const portion = Number(log.servingGrams)/100;
        const calories = log.calories == null ? "—" : Math.round(Number(log.calories)*portion)+" kcal";
        return `<article class="diet-log-row"><div><strong>${esc(log.name)}</strong><p>${esc(log.brand || "")} · ${esc(log.servingGrams)} g · ${calories}</p><small>${esc(log.source)} · ${esc(log.verificationStatus)}</small></div><button class="btn btn-outline diet-delete" data-id="${esc(log.id)}" type="button" aria-label="Delete ${esc(log.name)}">Delete</button></article>`;
      }).join("") : '<p class="muted">No food logged yet today. Scan a packaged food or enter a meal manually.</p>';
      list.querySelectorAll(".diet-delete").forEach((button) => button.addEventListener("click", async () => {
        if (!confirm("Delete this food log?")) return;
        try { await API.del("/food-scanner/logs/" + encodeURIComponent(button.dataset.id)); await loadDiary(); }
        catch (error) { alert(error.message || "Could not delete food."); }
      }));
    } catch (error) {
      document.getElementById("diet-totals").textContent = "Diary unavailable: " + (error.message || "please sign in again");
    }
  }
  async function findNearby() {
    const panel = document.getElementById("diet-nearby-panel");
    if (!navigator.geolocation) { panel.innerHTML = '<p class="muted">Location is unavailable. Use the existing Healthy Food Near You flow or enter a location in your maps app.</p>'; return; }
    panel.innerHTML = '<p class="muted">Waiting for your permission to use location…</p>';
    navigator.geolocation.getCurrentPosition(async (position) => {
      panel.innerHTML = '<p class="muted">Searching configured maps provider…</p>';
      try {
        const data = await API.post("/food/healthy-nearby",{latitude:position.coords.latitude,longitude:position.coords.longitude});
        if (!data.recommendations?.length) { panel.innerHTML = '<p class="muted">No verified menu items were returned by the configured provider. No restaurants or prices have been invented.</p>'; return; }
        panel.innerHTML = data.recommendations.slice(0,8).map((place) => `<article class="diet-log-row"><div><strong>${esc(place.name || place.restaurantName || "Nearby place")}</strong><p>${esc(place.address || place.locality || "")}</p></div></article>`).join("");
      } catch (error) { panel.innerHTML = `<div class="banner banner-info">${esc(error.message || "Nearby search is not configured or returned no verified results.")}</div>`; }
    }, (error) => { panel.innerHTML = `<div class="banner banner-info">${esc(error.message === "User denied Geolocation" ? "Location permission was declined. You can still use barcode scanning and manual entry." : "Could not read your location. You can still use barcode scanning and manual entry.")}</div>`; }, { enableHighAccuracy:false,timeout:10000,maximumAge:60000 });
  }
  window.addEventListener("pagehide",stopCamera);
  // app.js calls loadDiet when the authenticated Diet tab is opened. Replacing
  // that function keeps the existing tab, auth gate, and navigation intact.
  const previousLoadDiet = window.loadDiet;
  window.loadDiet = async function () { shell(); };
  // If the Diet tab was already rendered before this script initialized.
  if (document.getElementById("screen-diet")?.classList.contains("active")) shell();
})();