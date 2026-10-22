(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const root = $("fitos-food-tracker");
  if (!root || root.dataset.initialized) return;
  root.dataset.initialized = "true";
  const state = { product: null, scanner: null, logs: [], pendingManual: false, profile: null, nutritionTargets: null, searchProducts: [] };
  const num = (v) => v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const fmt = (v, unit = "") => v === null || v === undefined ? "Not available" : `${Number(v.toFixed ? v.toFixed(1) : v)}${unit}`;
  const api = (path, opts = {}) => {
    // api.js declares `const Api`, which is a global binding but not a window property; accept either.
    const client = window.Api || (typeof Api !== "undefined" ? Api : null);
    if (!client) throw new Error("FitOS API client is not ready. Refresh the page and try again.");
    const method = (opts.method || "GET").toUpperCase();
    if (method === "GET") return client.get(path);
    if (method === "POST") return client.post(path, opts.body || {}, { timeoutMs: opts.timeoutMs });
    if (method === "DELETE") return client.del(path);
    throw new Error("Unsupported request method.");
  };
  const round2 = (v) => v === null ? null : Math.round(v * 100) / 100;
  const localDate = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
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
  let lookupInFlight = false;
  async function lookupBarcode(raw) {
    const code = String(raw || "").trim();
    if (!/^(?:\d{8}|\d{12,14})$/.test(code)) throw new Error("Barcode must contain 8, 12, 13, or 14 digits.");
    if (lookupInFlight) return;
    lookupInFlight = true;
    setStatus("food-camera-status", "Looking up product…");
    try {
      const result = await api("/nutrition/foods/barcode/" + encodeURIComponent(code));
      state.product = result.product; state.pendingManual = false; renderReview(result.product);
      setStatus("food-camera-status", "Product found. Check the serving and nutrient values before logging.");
    } catch (error) {
      // Product missing, upstream down, or timed out: say so and keep manual entry one tap away.
      const hint = error.status === 404 || error.status === 422 ? " You can use manual entry below." : " You can retry, or use manual entry below.";
      setStatus("food-camera-status", (error.message || "Product lookup failed.") + hint, true);
    } finally { lookupInFlight = false; }
  }
  // FitOS food-search retrieval and typo-tolerance layer.
  // This is a deterministic lexical baseline; a neural Siamese model and LambdaMART
  // should only be enabled after FitOS has representative labeled query/click data.
  const FOOD_VOCABULARY = [
    "greek yogurt", "yogurt", "curd", "dahi", "paneer", "tofu", "soya chunks",
    "protein powder", "protein bar", "oats", "muesli", "chole", "chana", "chickpeas",
    "rajma", "dal", "lentils", "rice", "roti", "chapati", "poha", "upma",
    "idli", "dosa", "dhokla", "thepla", "khichdi", "sprouts", "peanuts",
    "almonds", "milk", "buttermilk", "lassi", "cheese", "peanut butter",
    "bread", "eggs", "banana", "apple"
  ];
  // Candidate vocabulary, not typo pairs: correction is inferred from edit distance and phonetic similarity.
  // This baseline can be replaced by a catalog-backed index or a trained Siamese model when query data exists.
  function normalizeFoodQuery(value) {
    return String(value || "").normalize("NFKC").toLocaleLowerCase("en-US")
      .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  }
  function editDistance(a, b) {
    // Damerau-Levenshtein distance: insertions, deletions, substitutions and adjacent swaps.
    const left = Array.from(a), right = Array.from(b);
    const d = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
    for (let i = 0; i <= left.length; i++) d[i][0] = i;
    for (let j = 0; j <= right.length; j++) d[0][j] = j;
    for (let i = 1; i <= left.length; i++) {
      for (let j = 1; j <= right.length; j++) {
        const cost = left[i - 1] === right[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
        }
      }
    }
    return d[left.length][right.length];
  }
  function phoneticKey(value) {
    // Lightweight Soundex-style key for Latin-script food names; edit distance remains the primary signal.
    const word = String(value || "").normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "")
      .toLocaleLowerCase("en-US").replace(/[^a-z]/g, "");
    if (!word) return "";
    const code = { b: "1", f: "1", p: "1", v: "1", c: "2", g: "2", j: "2", k: "2", q: "2", s: "2", x: "2", z: "2", d: "3", t: "3", l: "4", m: "5", n: "5", r: "6" };
    let out = word[0].toUpperCase(), previous = code[word[0]] || "";
    for (const char of word.slice(1)) {
      const digit = code[char] || "";
      if (digit && digit !== previous) out += digit;
      previous = digit;
      if (out.length === 4) break;
    }
    return (out + "000").slice(0, 4);
  }
  function correctFoodQuery(value) {
    const original = normalizeFoodQuery(value);
    const candidates = [...new Set(FOOD_VOCABULARY.flatMap((phrase) => normalizeFoodQuery(phrase).split(" ")))];
    const correctedWords = original.split(" ").map((word) => {
      if (word.length < 4 || candidates.includes(word)) return word;
      let best = word, bestScore = Infinity;
      for (const candidate of candidates) {
        if (Math.abs(candidate.length - word.length) > 2) continue;
        const distance = editDistance(word, candidate);
        const phoneticMatch = phoneticKey(word) === phoneticKey(candidate);
        const allowed = word.length >= 8 ? 2 : 1;
        if (distance > allowed && !phoneticMatch) continue;
        // Prefer close spellings; phonetics break ties rather than overriding strong lexical evidence.
        const score = distance - (phoneticMatch ? 0.35 : 0);
        if (score < bestScore) { best = candidate; bestScore = score; }
      }
      return best;
    });
    const corrected = correctedWords.join(" ");
    return { original, corrected, changed: corrected !== original };
  }
  function nutritionScore(product) {
    const n = product.nutrimentsPer100g || {};
    const components = [];
    if (num(n.proteinG) !== null) components.push(Math.min(100, num(n.proteinG) * 5));
    if (num(n.fiberG) !== null) components.push(Math.min(100, num(n.fiberG) * 8));
    if (num(n.sugarsG) !== null) components.push(Math.max(0, 100 - num(n.sugarsG) * 5));
    if (num(n.saturatedFatG) !== null) components.push(Math.max(0, 100 - num(n.saturatedFatG) * 10));
    if (num(n.saltG) !== null) components.push(Math.max(0, 100 - num(n.saltG) * 30));
    if (!components.length) return null;
    return Math.round(components.reduce((sum, value) => sum + value, 0) / components.length);
  }
  function productRelevance(product, query) {
    const q = normalizeFoodQuery(query);
    const name = normalizeFoodQuery(product.name);
    const brand = normalizeFoodQuery(product.brand);
    if (!q) return 0;
    return (name === q ? 100 : name.startsWith(q) ? 65 : name.includes(q) ? 45 : 0) +
      (brand.includes(q) ? 15 : 0) + q.split(" ").filter((word) => name.includes(word)).length * 8;
  }
  function renderProductResult(product) {
    const image = product.imageUrl ? `<img src="${esc(product.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : "";
    const basis = product.nutrimentsPer100g?.basis || "Nutrition basis not specified";
    const n = product.nutrimentsPer100g || {};
    const score = nutritionScore(product);
    const nutrientSummary = [
      num(n.proteinG) === null ? null : `Protein ${fmt(n.proteinG, " g")}`,
      num(n.caloriesKcal) === null ? null : `${fmt(n.caloriesKcal, " kcal")}`,
      num(n.sugarsG) === null ? null : `Sugar ${fmt(n.sugarsG, " g")}`,
    ].filter(Boolean).join(" · ");
    return `<article class="food-product-result">${image}<div class="food-result-main"><strong>${esc(product.name)}</strong><small>${esc(product.brand || "Brand not listed")} · ${esc(product.code || product.externalFoodId || "Food database entry")} · ${esc(product.quantity || product.servingSize || "Portion details not listed")}</small><small>${esc(basis)}</small>${nutrientSummary ? `<small class="food-smart-nutrients">${esc(nutrientSummary)} per 100 g/ml</small>` : ""}${score === null ? '<small class="food-smart-limited">Nutrition data limited · compare the package label</small>' : `<small class="food-smart-score">Nutrition profile score: ${score}/100 · based only on available label fields</small>`}<button type="button" class="btn btn-outline" data-select-product="${esc(product.code || product.externalFoodId || product.name)}">Review & log</button></div></article>`;
  }
  async function fetchFoodProducts(query) {
    const result = await api("/nutrition/foods/search?q=" + encodeURIComponent(query));
    return Array.isArray(result.products) ? result.products : [];
  }
  function combinedSearchScore(product, query) {
    const relevance = productRelevance(product, query);
    const nutrition = nutritionScore(product);
    return relevance * 0.7 + (nutrition === null ? 50 : nutrition) * 0.3;
  }
  async function searchProducts(query) {
    const correction = correctFoodQuery(query);
    const searchedQuery = correction.corrected;
    // Query both the user's spelling and the corrected spelling, then merge by barcode.
    // This improves recall without depending on one upstream search index response.
    const queries = [...new Set([searchedQuery, correction.original].filter((item) => item.length >= 2))];
    const batches = await Promise.all(queries.map(async (term) => {
      try { return await fetchFoodProducts(term); } catch { return []; }
    }));
    const byCode = new Map();
    for (const product of batches.flat()) {
      const key = String(product.code || (normalizeFoodQuery(product.name) + "|" + normalizeFoodQuery(product.brand)));
      if (!byCode.has(key)) byCode.set(key, product);
    }
    const fetchedProducts = [...byCode.values()];
    state.searchProducts = fetchedProducts;
    const products = fetchedProducts
      .map((product) => {
        const relevance = Math.max(productRelevance(product, searchedQuery), productRelevance(product, correction.original));
        const nutrition = nutritionScore(product);
        // Retrieval relevance dominates nutrition; nutrition only breaks close matches.
        const score = relevance * 0.8 + (nutrition === null ? 50 : nutrition) * 0.2;
        return { product, relevance, score };
      })
      .filter((item) => item.relevance > 0)
      .sort((a, b) => b.score - a.score || b.relevance - a.relevance)
      .map((item) => item.product);
    const results = $("food-search-results");
    const correctionNote = correction.changed
      ? `<p class="food-smart-correction" role="status">Showing results for <strong>${esc(correction.corrected)}</strong>. <button type="button" class="food-smart-keep-query" id="food-search-keep-original">Search “${esc(correction.original)}” instead</button></p>`
      : "";
    results.innerHTML = correctionNote + (products.length
      ? '<p class="food-smart-recommendation-heading">Best matches, ranked by name relevance first and available nutrition second</p>' + products.map(renderProductResult).join("")
      : '<p class="food-empty">No matching products were returned. Try a shorter name or another spelling, or enter the package label manually.</p>');
    $("food-search-keep-original")?.addEventListener("click", async () => {
      $("food-search-input").value = correction.original;
      const originalProducts = await fetchFoodProducts(correction.original);
      originalProducts.sort((a, b) =>
        productRelevance(b, correction.original) - productRelevance(a, correction.original) ||
        combinedSearchScore(b, correction.original) - combinedSearchScore(a, correction.original)
      );
      results.innerHTML = originalProducts.length ? originalProducts.map(renderProductResult).join("") :
        '<p class="food-empty">No products found for the original search. Try another spelling or enter the package label manually.</p>';
    });
  }
  const foodSearchInput = $("food-search-input");
  const foodSearchForm = $("food-search-form");
  const foodSearchResults = $("food-search-results");
  let suggestionPanel = $("food-search-suggestions");
  if (!suggestionPanel) {
    suggestionPanel = document.createElement("div");
    suggestionPanel.id = "food-search-suggestions";
    suggestionPanel.className = "food-search-suggestions";
    suggestionPanel.setAttribute("role", "listbox");
    suggestionPanel.setAttribute("aria-label", "Food search suggestions");
    foodSearchForm.insertAdjacentElement("afterend", suggestionPanel);
  }
  let suggestionTimer = null;
  let suggestionRequest = 0;
  function hideFoodSuggestions() {
    suggestionPanel.hidden = true;
    suggestionPanel.replaceChildren();
    foodSearchInput?.setAttribute("aria-expanded", "false");
  }
  function showFoodSuggestions(query, products, corrected) {
    // Keep the selectable suggestion objects in sync with the current search response.
    // Previously selectProduct() only searched state.searchProducts, which was populated
    // by the full Search form, not by autocomplete. Tapping a valid suggestion therefore
    // produced the misleading "result is no longer available" error.
    state.searchProducts = Array.isArray(products) ? products : [];
    const seen = new Set();
    const options = [];
    if (corrected.changed) options.push({ label: corrected.corrected, detail: "Did you mean?", correction: true });
    const relevantProducts = products
      .map((product) => ({ product, relevance: productRelevance(product, corrected.corrected || query) }))
      .filter((item) => item.relevance > 0)
      .sort((a, b) => b.relevance - a.relevance)
      .map((item) => item.product);
    for (const product of relevantProducts) {
      const label = String(product.name || "").trim();
      if (!label || seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      options.push({ label, detail: product.brand || "Food item", code: product.code });
      if (options.length >= 6) break;
    }
    suggestionPanel.innerHTML = options.map((option, index) =>
      `<button type="button" role="option" aria-selected="false" class="food-search-suggestion" data-suggestion-index="${index}"><span><strong>${esc(option.label)}</strong><small>${esc(option.detail)}</small></span><span aria-hidden="true">↗</span></button>`
    ).join("") || '<p class="food-search-suggestion-empty">Keep typing to search food products.</p>';
    suggestionPanel.hidden = false;
    foodSearchInput?.setAttribute("aria-expanded", "true");
    suggestionPanel.querySelectorAll("[data-suggestion-index]").forEach((button, index) => {
      button.addEventListener("click", () => {
        const option = options[index];
        foodSearchInput.value = option.label;
        hideFoodSuggestions();
        if (option.code && !option.correction) {
          selectProduct(option.code).catch((error) => {
            foodSearchResults.insertAdjacentHTML("afterbegin", `<p class="food-empty" role="alert">${esc(error.message)}</p>`);
          });
        } else {
          foodSearchForm.requestSubmit();
        }
      });
    });
  }
  foodSearchInput?.setAttribute("autocomplete", "off");
  foodSearchInput?.setAttribute("role", "combobox");
  foodSearchInput?.setAttribute("aria-autocomplete", "list");
  foodSearchInput?.setAttribute("aria-controls", "food-search-suggestions");
  foodSearchInput?.setAttribute("aria-expanded", "false");
  foodSearchInput?.addEventListener("input", () => {
    clearTimeout(suggestionTimer);
    const query = foodSearchInput.value.trim();
    // Never leave results from a previous query visible under a new search term.
    foodSearchResults.innerHTML = "";
    if (query.length < 2) return hideFoodSuggestions();
    suggestionTimer = setTimeout(async () => {
      const requestId = ++suggestionRequest;
      const correction = correctFoodQuery(query);
      try {
        const products = await fetchFoodProducts(correction.corrected);
        if (requestId !== suggestionRequest || foodSearchInput.value.trim() !== query) return;
        showFoodSuggestions(query, products, correction);
      } catch (error) {
        if (requestId !== suggestionRequest) return;
        suggestionPanel.innerHTML = '<p class="food-search-suggestion-empty">Suggestions are temporarily unavailable. Tap Search to retry.</p>';
        suggestionPanel.hidden = false;
        foodSearchInput?.setAttribute("aria-expanded", "true");
      }
    }, 350);
  });
  foodSearchInput?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideFoodSuggestions();
    if (event.key === "ArrowDown" && !suggestionPanel.hidden) {
      event.preventDefault();
      suggestionPanel.querySelector("button[data-suggestion-index]")?.focus();
    }
  });
  suggestionPanel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { hideFoodSuggestions(); foodSearchInput.focus(); }
  });
  document.addEventListener("click", (event) => {
    if (!foodSearchForm.contains(event.target) && !suggestionPanel.contains(event.target)) hideFoodSuggestions();
  });
  async function selectProduct(identifier) {
    const product = state.searchProducts.find((item) => String(item.code || item.externalFoodId || item.name) === String(identifier));
    if (!product) throw new Error("This food result is no longer available. Search again and select it.");
    state.product = product;
    state.pendingManual = false;
    renderReview(product);
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
      <p class="food-data-note">${esc(n.basis || "Values from the food record or your entered label")}. Values not available stay blank. Please verify them against the package label when possible.</p>
      <div class="food-review-grid">
        <label>Serving amount (g/ml)<input id="food-review-serving" type="number" min="1" max="10000" value="${product.servingQuantityG || 100}" required></label>
        <label>Serving unit<select id="food-review-unit"><option value="g">g</option><option value="ml">ml</option></select></label>
        <label>Calories (kcal / 100 g/ml)<input id="food-review-calories" type="number" min="0" step="0.1" value="${n.caloriesKcal ?? ""}" placeholder="Not listed"></label>
        <label>Protein (g / 100 g/ml)<input id="food-review-protein" type="number" min="0" step="0.1" value="${n.proteinG ?? ""}" placeholder="Not listed"></label>
        <label>Carbohydrate (g / 100 g/ml)<input id="food-review-carbs" type="number" min="0" step="0.1" value="${n.carbsG ?? ""}" placeholder="Not listed"></label>
        <label>Fat (g / 100 g/ml)<input id="food-review-fat" type="number" min="0" step="0.1" value="${n.fatG ?? ""}" placeholder="Not listed"></label>
        <label>Fiber (g / 100 g/ml)<input id="food-review-fiber" type="number" min="0" step="0.1" value="${n.fiberG ?? ""}" placeholder="Not listed"></label>
      </div>
      <p class="food-data-note">${product.servingQuantityG ? `Package serving: ${esc(product.servingSize || product.servingQuantityG + " g")} (prefilled). ` : ""}The values above are per 100 g/ml. FitOS scales the available values to your selected serving. Confirm the package label and correct values if needed.</p>
      <div id="food-nutrition-guidance" class="food-nutrition-guidance" aria-live="polite"></div><div class="food-review-actions"><button type="button" class="btn btn-mint" id="food-confirm-log">Confirm & add to today</button><button type="button" class="btn btn-outline" id="food-cancel-review">Cancel</button></div>
      <p id="food-review-status" class="food-status" aria-live="polite"></p>`;
    $("food-confirm-log").addEventListener("click", confirmLog);
    $("food-review-serving").addEventListener("input", renderNutritionGuidance);
    renderNutritionGuidance();
    $("food-cancel-review").addEventListener("click", () => { container.hidden = true; state.product = null; });
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
      caloriesKcal: field("food-review-calories") === null ? null : round2(field("food-review-calories") * scale),
      proteinG: field("food-review-protein") === null ? null : round2(field("food-review-protein") * scale),
      carbsG: field("food-review-carbs") === null ? null : round2(field("food-review-carbs") * scale),
      fatG: field("food-review-fat") === null ? null : round2(field("food-review-fat") * scale),
      fiberG: field("food-review-fiber") === null ? null : round2(field("food-review-fiber") * scale),
      source: state.pendingManual ? "manual_label" : (product.source === "Spoonacular" ? "spoonacular" : product.source === "BonHappetee Food Nutrition API" ? "bonhappetee" : "open_food_facts")
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
    // Keep product search entirely client-side. Prevent native form navigation before
    // any validation or async work so the page never reloads and clears the results.
    event.preventDefault();
    event.stopPropagation();
    const query = $("food-search-input").value.trim();
    hideFoodSuggestions();
    const results = $("food-search-results");
    if (query.length < 2) {
      results.innerHTML = '<p class="food-empty" role="status">Enter at least 2 characters to search.</p>';
      return;
    }
    const button = $("food-search-form").querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    results.innerHTML = '<p class="food-empty" role="status">Searching foods…</p>';
    try {
      await searchProducts(query);
    } catch (error) {
      results.innerHTML = `<p class="food-empty" role="alert">${esc(error.message || "Product search failed. Please try again.")}</p>`;
    } finally {
      if (button) button.disabled = false;
    }
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
    // The manual form asks for label values for the serving amount entered. The review screen works per 100 g/ml,
    // so convert once here; logging then scales back to exactly what the user typed.
    const servingAmount = Number(values.serving);
    const per100 = (v) => { const n = num(v); return n === null || !(servingAmount > 0) ? null : Math.round(n * 100 / servingAmount * 1000) / 1000; };
    state.product = { code: "", name: String(values.name).trim(), brand: "", source: "Manual label", verificationStatus: "user_entered_label", nutrimentsPer100g: {
      basis: "Values entered by you from the package label (converted to per 100 g/ml)",
      caloriesKcal: per100(values.calories), proteinG: per100(values.protein), carbsG: per100(values.carbs), fatG: per100(values.fat), fiberG: null
    }};
    renderReview(state.product);
    $("food-review-serving").value = values.serving;
    $("food-product-review").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  async function startCamera() {
    if (!window.FitOSBarcode) return setStatus("food-camera-status", "The barcode scanner component did not load. Refresh the page or enter the barcode manually.", true);
    stopCamera();
    const video = $("food-barcode-video");
    state.scanner = window.FitOSBarcode.createScanner({
      video,
      onStatus: (message, isError) => setStatus("food-camera-status", message, !!isError),
      onDetected: (code) => {
        resetCameraUi();
        $("food-barcode-input").value = code;
        lookupBarcode(code).catch((error) => setStatus("food-camera-status", error.message, true));
      },
    });
    video.hidden = false; video.classList.add("food-camera-video");
    $("food-camera-start").disabled = true; $("food-camera-stop").disabled = false;
    try { await state.scanner.start(); }
    catch (error) { stopCamera(); setStatus("food-camera-status", error.message, true); }
  }
  function resetCameraUi() {
    const video = $("food-barcode-video");
    if (video) { video.hidden = true; }
    if ($("food-camera-start")) $("food-camera-start").disabled = false;
    if ($("food-camera-stop")) $("food-camera-stop").disabled = true;
  }
  function stopCamera() {
    if (state.scanner) { state.scanner.stop(); state.scanner = null; }
    resetCameraUi();
  }
  $("food-camera-start").addEventListener("click", startCamera);
  $("food-camera-stop").addEventListener("click", stopCamera);
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopCamera(); });
  async function loadLogs() {
    const result = await api("/nutrition/logs?date=" + localDate() + "&tzOffset=" + new Date().getTimezoneOffset());
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
    const results = $("food-nearby-results");
    results.innerHTML = "";
    setStatus("food-nearby-status", "Finding real menu dishes near you and ranking health plus distance…");
    try {
      const result = await api("/food/healthy-nearby", {
        method: "POST",
        body: { latitude, longitude },
        timeoutMs: 150000,
      });
      const recommendations = Array.isArray(result.recommendations) ? result.recommendations : [];
      if (!recommendations.length) {
        const message = result.error || "The live provider returned no menu dishes for this location. No dishes were invented.";
        results.innerHTML = `<p class="food-empty">${esc(message)}</p>`;
        setStatus("food-nearby-status", "Location: " + label + ". No ranked dishes were returned.", true);
        return;
      }
      results.innerHTML = recommendations.map((item, index) => {
        const url = typeof item.restaurantUrl === "string" && /^https:\/\//i.test(item.restaurantUrl) ? item.restaurantUrl : "";
        const hasDistance = item.distanceKm !== null && item.distanceKm !== undefined && Number.isFinite(Number(item.distanceKm));
        const distance = hasDistance ? Number(item.distanceKm).toFixed(1) + " km away" : "Distance unavailable";
        const hasPrice = item.priceInr !== null && item.priceInr !== undefined && Number.isFinite(Number(item.priceInr)) && Number(item.priceInr) > 0;
        const price = hasPrice ? "₹" + Math.round(Number(item.priceInr)) : "Price unavailable";
        const hasScore = item.healthScore !== null && item.healthScore !== undefined && Number.isFinite(Number(item.healthScore));
        const score = hasScore ? Math.round(Number(item.healthScore)) : null;
        const proteinValue = item.proteinG ?? item.estProteinG;
        const caloriesValue = item.calories ?? item.estCalories;
        const hasProtein = proteinValue !== null && proteinValue !== undefined && Number.isFinite(Number(proteinValue));
        const hasCalories = caloriesValue !== null && caloriesValue !== undefined && Number.isFinite(Number(caloriesValue));
        const protein = hasProtein ? `~${Number(proteinValue)} g` : "Not listed";
        const calories = hasCalories ? `~${Number(caloriesValue)} kcal` : "Not listed";
        const reasons = Array.isArray(item.reasons) ? item.reasons.map(esc).join(" · ") : "";
        const rating = item.restaurantRating !== null && item.restaurantRating !== undefined && Number.isFinite(Number(item.restaurantRating)) ? `★ ${Number(item.restaurantRating).toFixed(1)}` : "";
        const dishName = esc(item.dishName || item.name || "Menu dish");
        const restaurantName = esc(item.restaurantName || "Restaurant");
        const locality = esc(item.locality || "");
        const confidence = item.nutritionConfidence === "verified" ? "Verified label" : item.nutritionConfidence === "llm_estimated" ? "AI estimate" : "Unverified menu data";
        return `<article class="food-nearby-card"><div class="food-nearby-card-top"><span class="food-rank">OPTION ${String(index + 1).padStart(2, "0")}</span><span class="food-health-score">${hasScore ? `${score}<small>/100</small>` : "Score n/a"}</span></div><h3>${dishName}</h3><p class="food-nearby-restaurant">${restaurantName}</p><div class="food-nearby-meta"><span>⌖ ${esc(distance)}</span>${rating ? `<span>${esc(rating)}</span>` : ""}<span>${esc(price)}</span></div><div class="food-nearby-nutrition"><div><small>PROTEIN</small><strong>${esc(protein)}</strong></div><div><small>CALORIES</small><strong>${esc(calories)}</strong></div></div><p class="food-nearby-locality">${locality}</p>${reasons ? `<p class="food-nearby-reasons">${reasons}</p>` : ""}<div class="food-nearby-card-footer"><span>${esc(confidence)}</span>${url ? `<a class="food-nearby-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">View menu <span aria-hidden="true">↗</span></a>` : ""}</div><p class="food-nearby-disclaimer">${esc(item.nutritionDisclaimer || "Nutrition may be estimated. Confirm ingredients, serving size and values with the restaurant.")}</p></article>`;
      }).join("");
      setStatus("food-nearby-status", `Location: ${label}. Ranked ${recommendations.length} dishes from ${result.restaurantsFound || "nearby"} restaurants. ${result.ranking || ""}`);
    } catch (error) {
      const message = error?.message || "Nearby food search failed.";
      results.innerHTML = `<p class="food-empty">${esc(message)}</p>`;
      setStatus("food-nearby-status", message, true);
    }
  }
  $("food-nearby-location").addEventListener("click", () => {
    if (!navigator.geolocation) return setStatus("food-nearby-status", "Geolocation is unavailable in this browser.", true);
    setStatus("food-nearby-status", "Waiting for your location permission…");
    navigator.geolocation.getCurrentPosition(
      (position) => nearbyWithCoords(position.coords.latitude, position.coords.longitude, "your device location"),
      (error) => setStatus("food-nearby-status", error.code === 1 ? "Location permission denied. No location was sent." : error.code === 3 ? "Location request timed out. Try again with GPS enabled." : "Could not get location. Check device location settings and try again.", true),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 }
    );
  });
  $("food-nearby-manual-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const query = $("food-nearby-query").value.trim();
    if (!query) return setStatus("food-nearby-status", "Enter a place name or use GPS.", true);
    setStatus("food-nearby-status", "Text-address search is not connected to a geocoder yet. Use GPS for live nearby ranking.", true);
  });
  root.addEventListener("click", (event) => {
    const link = event.target.closest("a");
    if (link && link.href && !link.href.startsWith(window.location.origin)) link.rel = "noopener noreferrer";
  });
  window.addEventListener("beforeunload", stopCamera);
  void loadNutritionProfile();
  // Safety net: never let these forms navigate the page. This must run in the BUBBLE phase and must not call
  // stopPropagation(): a capture-phase stopPropagation at the root keeps the event from ever reaching the forms' own
  // submit handlers, which silently disabled barcode lookup and product search.
  root.addEventListener("submit", (event) => {
    const form = event.target;
    if (form instanceof HTMLFormElement && ["food-search-form", "food-barcode-form"].includes(form.id)) event.preventDefault();
  });
  // Load log only when requested; do not make the Diet screen wait on the API.
})();
