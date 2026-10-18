(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const root = $("fitos-food-tracker");
  if (!root || root.dataset.initialized) return;
  root.dataset.initialized = "true";
  const state = { product: null, stream: null, scanTimer: null, logs: [], pendingManual: false, profile: null, nutritionTargets: null };
  const num = (v) => v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const fmt = (v, unit = "") => v === null || v === undefined ? "Not available" : `${Number(v.toFixed ? v.toFixed(1) : v)}${unit}`;
  const api = (path, opts = {}) => {
    if (!window.Api) throw new Error("FitOS API client is not ready. Refresh the page and try again.");
    const method = (opts.method || "GET").toUpperCase();
    if (method === "GET") return window.Api.get(path);
    if (method === "POST") return window.Api.post(path, opts.body || {});
    if (method === "DELETE") return window.Api.del(path);
    throw new Error("Unsupported request method.");
  };
  function setStatus(id, message, isError = false) { const el = $(id); if (el) { el.textContent = message; el.style.color = isError ? "#a52b2b" : ""; } }
  function showView(view) {
    root.querySelectorAll("[data-food-view]").forEach((button) => {
      const active = button.dataset.foodView === view;
      button.classList.toggle("active", active); button.setAttribute("aria-selected", String(active));
    });
    root.querySelectorAll(".food-view").forEach((panel) => { panel.hidden = panel.id !== "food-view-" + view; });
    if (view === "log") loadLogs().catch((e) => setStatus("food-nearby-status", e.message, true));
  }
  root.querySelectorAll("[data-food-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.foodView)));
  async function lookupBarcode(raw) {
    const code = String(raw || "").trim();
    if (!/^(?:\d{8}|\d{12,14})$/.test(code)) throw new Error("Barcode must contain 8, 12, 13, or 14 digits.");
    setStatus("food-camera-status", "Looking up product in Open Food Facts…");
    const result = await api("/nutrition/foods/barcode/" + encodeURIComponent(code));
    state.product = result.product; state.pendingManual = false; renderReview(result.product);
    setStatus("food-camera-status", "Product found. Check the serving and nutrient values before logging.");
  }
  function renderProductResult(product) {
    const image = product.imageUrl ? `<img src="${esc(product.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : "";
    const basis = product.nutrimentsPer100g?.basis || "Nutrition basis not specified";
    return `<article class="food-product-result">${image}<div class="food-result-main"><strong>${esc(product.name)}</strong><small>${esc(product.brand || "Brand not listed")} · ${esc(product.code)} · ${esc(product.quantity || "Package size not listed")}</small><small>${esc(basis)}</small><button type="button" class="btn btn-outline" data-select-product="${esc(product.code)}">Review & log</button></div></article>`;
  }
  async function searchProducts(query) {
    const result = await api("/nutrition/foods/search?q=" + encodeURIComponent(query));
    $("food-search-results").innerHTML = result.products.length ? result.products.map(renderProductResult).join("") : '<p class="food-empty">No products found. Try a shorter name or enter the package label manually.</p>';
  }
  async function selectProduct(code) {
    const result = await api("/nutrition/foods/barcode/" + encodeURIComponent(code));
    state.product = result.product; state.pendingManual = false; renderReview(result.product);
    $("food-product-review").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  async function loadNutritionProfile() {
    try {
      const profile = await api("/user/profile");
      state.profile = profile.profile || profile;
      state.nutritionTargets = profile.nutritionTargets || null;
      if (!state.nutritionTargets) {
        try { state.nutritionTargets = await api("/nutrition/targets"); } catch { /* profile-based estimates remain available */ }
      }
      renderNutritionGuidance();
    } catch { /* onboarding may not be complete; use general references */ }
  }
  function renderNutritionGuidance() {
    const output = $("food-nutrition-guidance");
    if (!output || !state.product || !window.FitOSNutritionGuidance) return;
    const serving = Number($("food-review-serving")?.value || 100);
    const n = state.product.nutrimentsPer100g || {};
    const guidance = window.FitOSNutritionGuidance.assess({
      nutrients: n, servingGrams: serving, profile: state.profile || {},
      targets: state.nutritionTargets || {}
    });
    output.innerHTML = `<h4>How this serving fits your day</h4>
      <p class="food-data-note">Guidance uses your saved profile and nutrition targets where available, plus general adult reference values. It is not a diagnosis or a simple healthy/unhealthy verdict.</p>
      <ul>${guidance.notes.map((note) => `<li>${esc(note)}</li>`).join("")}</ul>
      <p class="food-data-note">General references: sodium under 2,000 mg/day; caffeine up to 400 mg/day for most healthy adults; fibre about 25 g/day; free sugars ideally below 50 g/day on a 2,000 kcal diet. Product total sugars may differ from free sugars. Pregnancy, medication, health conditions, and age can change advice.</p>`;
  }
  function renderReview(product) {
    const n = product.nutrimentsPer100g || {};
    const container = $("food-product-review");
    container.hidden = false;
    container.innerHTML = `<h3>Confirm food before logging</h3>
      <p><strong>${esc(product.name)}</strong> · ${esc(product.brand || "Brand not listed")}</p>
      ${product.imageUrl ? `<img src="${esc(product.imageUrl)}" alt="" width="84" loading="lazy" referrerpolicy="no-referrer">` : ""}
      <p class="food-data-note">Source: ${esc(product.source || "Manual label")} · ${esc(n.basis || "Values from user-entered label")} · ${esc(product.verificationStatus || "manual_label")}. Values missing from the source stay blank.</p>
      <div class="food-review-grid">
        <label>Serving amount (g/ml)<input id="food-review-serving" type="number" min="1" max="10000" value="100" required></label>
        <label>Serving unit<select id="food-review-unit"><option value="g">g</option><option value="ml">ml</option></select></label>
        <label>Calories (kcal / 100 g/ml)<input id="food-review-calories" type="number" min="0" step="0.1" value="${n.caloriesKcal ?? ""}" placeholder="Not listed"></label>
        <label>Protein (g / 100 g/ml)<input id="food-review-protein" type="number" min="0" step="0.1" value="${n.proteinG ?? ""}" placeholder="Not listed"></label>
        <label>Carbohydrate (g / 100 g/ml)<input id="food-review-carbs" type="number" min="0" step="0.1" value="${n.carbsG ?? ""}" placeholder="Not listed"></label>
        <label>Fat (g / 100 g/ml)<input id="food-review-fat" type="number" min="0" step="0.1" value="${n.fatG ?? ""}" placeholder="Not listed"></label>
        <label>Fiber (g / 100 g/ml)<input id="food-review-fiber" type="number" min="0" step="0.1" value="${n.fiberG ?? ""}" placeholder="Not listed"></label>
      </div>
      <p class="food-data-note">The values above are per 100 g/ml. FitOS scales the available values to your selected serving. Confirm the package label and correct values if needed.</p>
      <div id="food-nutrition-guidance" class="food-nutrition-guidance" aria-live="polite"></div><div class="food-review-actions"><button type="button" class="btn btn-mint" id="food-confirm-log">Confirm & add to today</button><button type="button" class="btn btn-outline" id="food-cancel-review">Cancel</button></div>
      <p id="food-review-status" class="food-status" aria-live="polite"></p>`;
    $("food-confirm-log").addEventListener("click", confirmLog);
    $("food-review-serving").addEventListener("input", renderNutritionGuidance);\n    renderNutritionGuidance();\n    $("food-cancel-review").addEventListener("click", () => { container.hidden = true; state.product = null; });
  }
  async function confirmLog() {
    const product = state.product;
    if (!product) return;
    const serving = Number($("food-review-serving").value);
    if (!Number.isFinite(serving) || serving <= 0 || serving > 10000) return setStatus("food-review-status", "Enter a valid serving amount.", true);
    const unit = $("food-review-unit").value;
    const scale = serving / 100;
    const field = (id) => num($(id).value);
    const payload = {
      productCode: state.pendingManual ? null : product.code,
      foodName: product.name,
      brand: product.brand || "",
      servingAmount: serving,
      servingUnit: unit,
      caloriesKcal: field("food-review-calories") === null ? null : field("food-review-calories") * scale,
      proteinG: field("food-review-protein") === null ? null : field("food-review-protein") * scale,
      carbsG: field("food-review-carbs") === null ? null : field("food-review-carbs") * scale,
      fatG: field("food-review-fat") === null ? null : field("food-review-fat") * scale,
      fiberG: field("food-review-fiber") === null ? null : field("food-review-fiber") * scale,
      source: state.pendingManual ? "manual_label" : "open_food_facts"
    };
    try {
      $("food-confirm-log").disabled = true;
      await api("/nutrition/logs", { method: "POST", body: payload });
      setStatus("food-review-status", "Added to today’s log.");
      await loadLogs();
      showView("log");
    } catch (error) { setStatus("food-review-status", error.message, true); }
    finally { if ($("food-confirm-log")) $("food-confirm-log").disabled = false; }
  }
  $("food-barcode-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try { await lookupBarcode($("food-barcode-input").value); }
    catch (error) { setStatus("food-camera-status", error.message, true); }
  });
  $("food-search-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = $("food-search-input").value.trim();
    if (query.length < 2) return;
    $("food-search-results").innerHTML = '<p class="food-empty">Searching Open Food Facts…</p>';
    try { await searchProducts(query); } catch (error) { $("food-search-results").innerHTML = `<p class="food-empty">${esc(error.message)}</p>`; }
  });
  $("food-search-results").addEventListener("click", (event) => {
    const button = event.target.closest("[data-select-product]");
    if (button) selectProduct(button.dataset.selectProduct).catch((e) => { $("food-search-results").insertAdjacentHTML("beforeend", `<p class="food-empty">${esc(e.message)}</p>`); });
  });
  $("food-manual-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const values = Object.fromEntries(data.entries());
    state.pendingManual = true;
    state.product = { code: "", name: String(values.name).trim(), brand: "", source: "Manual label", verificationStatus: "user_entered_label", nutrimentsPer100g: {
      basis: "Values entered by you from the package label; per 100 g/ml",
      caloriesKcal: num(values.calories), proteinG: num(values.protein), carbsG: num(values.carbs), fatG: num(values.fat), fiberG: null
    }};
    renderReview(state.product);
    $("food-review-serving").value = values.serving;
    $("food-product-review").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) return setStatus("food-camera-status", "Camera scanning is not supported in this browser. Enter the barcode manually.", true);
    if (!("BarcodeDetector" in window)) return setStatus("food-camera-status", "This browser does not expose barcode detection. Enter the barcode manually or use product search.", true);
    try {
      const detector = new BarcodeDetector({ formats: ["ean_8", "ean_13", "upc_a", "upc_e"] });
      state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      const video = $("food-barcode-video");
      video.hidden = false; video.srcObject = state.stream; video.classList.add("food-camera-video");
      await video.play();
      $("food-camera-start").disabled = true; $("food-camera-stop").disabled = false;
      setStatus("food-camera-status", "Camera is on. Hold a barcode in the frame.");
      const scan = async () => {
        if (!state.stream || video.readyState < 2) return;
        try {
          const codes = await detector.detect(video);
          const code = codes.find((item) => /^(?:\d{8}|\d{12,14})$/.test(item.rawValue || ""));
          if (code) {
            stopCamera();
            $("food-barcode-input").value = code.rawValue;
            try { await lookupBarcode(code.rawValue); } catch (error) { setStatus("food-camera-status", error.message, true); }
            return;
          }
        } catch { /* keep scanning; manual input remains available */ }
        state.scanTimer = requestAnimationFrame(scan);
      };
      state.scanTimer = requestAnimationFrame(scan);
    } catch (error) {
      stopCamera();
      setStatus("food-camera-status", error.name === "NotAllowedError" ? "Camera permission was denied. You can enter the barcode manually." : "Could not open the camera. Use manual barcode entry instead.", true);
    }
  }
  function stopCamera() {
    if (state.scanTimer) cancelAnimationFrame(state.scanTimer);
    state.scanTimer = null;
    if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
    const video = $("food-barcode-video");
    if (video) { video.pause(); video.srcObject = null; video.hidden = true; }
    if ($("food-camera-start")) $("food-camera-start").disabled = false;
    if ($("food-camera-stop")) $("food-camera-stop").disabled = true;
  }
  $("food-camera-start").addEventListener("click", startCamera);
  $("food-camera-stop").addEventListener("click", stopCamera);
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopCamera(); });
  async function loadLogs() {
    const result = await api("/nutrition/logs");
    state.logs = result.entries || [];
    const summary = result.totals || {};
    $("food-daily-summary").innerHTML = [
      ["Calories",summary.caloriesKcal,"kcal"],["Protein",summary.proteinG,"g"],["Carbs",summary.carbsG,"g"],["Fat",summary.fatG,"g"],["Fiber",summary.fiberG,"g"]
    ].map(([label,value,unit]) => `<div class="food-summary-tile"><strong>${fmt(value, unit === "kcal" ? " kcal" : " g")}</strong><small>${label} · available values only</small></div>`).join("");
    $("food-log-list").innerHTML = state.logs.length ? state.logs.map((entry) => `<article class="food-log-entry"><div class="food-result-main"><strong>${esc(entry.foodName)}</strong><small>${esc(entry.brand || "")} · ${esc(entry.servingAmount)} ${esc(entry.servingUnit)} · ${esc(entry.source)}</small><small>${fmt(entry.caloriesKcal," kcal")} · Protein ${fmt(entry.proteinG," g")} · Carbs ${fmt(entry.carbsG," g")} · Fat ${fmt(entry.fatG," g")}</small></div><div class="food-log-actions"><button type="button" data-delete-log="${esc(entry.id)}">Delete</button></div></article>`).join("") : '<p class="food-empty">No food logged today yet. Scan a package or enter its label values to get started.</p>';
  }
  $("food-refresh-log").addEventListener("click", () => loadLogs().catch((e) => { $("food-log-list").textContent = e.message; }));
  $("food-log-list").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-delete-log]");
    if (!button) return;
    if (!window.confirm("Delete this food log entry?")) return;
    try { await api("/nutrition/logs/" + encodeURIComponent(button.dataset.deleteLog), { method: "DELETE" }); await loadLogs(); }
    catch (error) { window.alert(error.message); }
  });
  async function nearbyWithCoords(latitude, longitude, label) {
    setStatus("food-nearby-status", "Searching for real nearby listings…");
    try {
      const result = await api("/food/nearby?lat=" + encodeURIComponent(latitude) + "&lng=" + encodeURIComponent(longitude));
      if (!result.configured || !result.places?.length) {
        $("food-nearby-results").innerHTML = `<p class="food-empty">${esc(result.message || "No real listings were returned by the configured places provider.")}</p>`;
        setStatus("food-nearby-status", "Location: " + label + ". No listings were invented.");
        return;
      }
      $("food-nearby-results").innerHTML = result.places.map((item) => {
        const p = item.place || item;
        const url = typeof p.restaurantUrl === "string" && /^https:\/\//i.test(p.restaurantUrl) ? p.restaurantUrl : "";
        return `<article class="food-nearby-entry"><div class="food-result-main"><strong>${esc(p.name || "Food place")}</strong><small>${esc(p.address || p.locality || "")}</small>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open listing</a>` : ""}</div></article>`;
      }).join("");
      setStatus("food-nearby-status", "Location: " + label + ". Results come from the configured places provider.");
    } catch (error) { setStatus("food-nearby-status", error.message, true); }
  }
  $("food-nearby-location").addEventListener("click", () => {
    if (!navigator.geolocation) return setStatus("food-nearby-status", "Geolocation is unavailable. Enter a place manually if your maps provider supports it.", true);
    setStatus("food-nearby-status", "Waiting for your location permission…");
    navigator.geolocation.getCurrentPosition((position) => nearbyWithCoords(position.coords.latitude, position.coords.longitude, "your device location"), (error) => setStatus("food-nearby-status", error.code === 1 ? "Location permission denied. No location was sent." : "Could not get location. You can search manually.", true), { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
  });
  $("food-nearby-manual-form").addEventListener("submit", (event) => {
    event.preventDefault();
    setStatus("food-nearby-status", "This app’s live places API currently accepts coordinates, not free-text addresses. Use GPS with permission or use the existing Healthy Food Near You section.");
  });
  root.addEventListener("click", (event) => {
    const link = event.target.closest("a");
    if (link && link.href && !link.href.startsWith(window.location.origin)) link.rel = "noopener noreferrer";
  });
  window.addEventListener("beforeunload", stopCamera);
  void loadNutritionProfile();\n  // Load log only when requested; do not make the Diet screen wait on the API.
})();