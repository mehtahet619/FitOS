(() => {
  const form = document.getElementById("price-guess-form");
  if (!form || typeof Api === "undefined") return;

  const input = document.getElementById("price-guess-input");
  const submit = document.getElementById("price-guess-submit");
  const feedback = document.getElementById("price-guess-feedback");
  const average = document.getElementById("price-guess-average");
  const count = document.getElementById("price-guess-count");
  const numberFormat = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
  const guestKey = "fitos-price-guess-guest-id";
  function getGuestId() {
    let id = localStorage.getItem(guestKey);
    if (!id) {
      id = typeof crypto?.randomUUID === "function"
        ? crypto.randomUUID()
        : "guest-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
      localStorage.setItem(guestKey, id);
    }
    return id;
  }
  const guestId = getGuestId();
  let summary = { authenticated: false, hasGuessed: false, userGuess: null };

  function renderSummary(data) {
    summary = {
      authenticated: Boolean(data?.authenticated),
      hasGuessed: Boolean(data?.hasGuessed),
      userGuess: Number.isSafeInteger(data?.userGuess) ? data.userGuess : null,
    };
    average.textContent = Number.isFinite(data?.average)
      ? `₹${numberFormat.format(data.average)} / month`
      : "Be the first to guess";
    const total = Number.isSafeInteger(data?.count) ? data.count : 0;
    count.textContent = `${total.toLocaleString("en-IN")} ${total === 1 ? "guess" : "guesses"} so far`;
    input.disabled = summary.hasGuessed;
    submit.disabled = summary.hasGuessed;
    if (summary.hasGuessed) {
      feedback.textContent = `You've already guessed ₹${numberFormat.format(summary.userGuess)}. One guess is allowed per account or browser.`;
      feedback.classList.remove("is-error");
    } else if (!feedback.classList.contains("is-error")) {
      feedback.textContent = "No sign-in required. Submit one guess from this browser, and help shape FitOS pricing.";
    }
  }

  async function loadSummary() {
    try {
      renderSummary(await Api.get("/pricing-guesses?guestId=" + encodeURIComponent(guestId)));
    } catch {
      average.textContent = "Temporarily unavailable";
      count.textContent = "Community average could not be loaded. Please try again later.";
      input.disabled = true;
      submit.disabled = true;
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (summary.hasGuessed) return;
    const price = Number(input.value);
    if (!Number.isSafeInteger(price) || price < 1 || price > 100000) {
      feedback.textContent = "Enter a whole amount between ₹1 and ₹1,00,000.";
      feedback.classList.add("is-error");
      input.focus();
      return;
    }
    submit.disabled = true;
    input.disabled = true;
    feedback.classList.remove("is-error");
    feedback.textContent = "Sending your guess…";
    try {
      const result = await Api.post("/pricing-guesses", { price, guestId });
      renderSummary(result);
      feedback.textContent = `Your guess of ₹${numberFormat.format(price)} is saved. Thanks for helping shape FitOS!`;
      input.value = "";
    } catch (error) {
      await loadSummary();
      if (!summary.hasGuessed) {
        feedback.textContent = error?.message || "Couldn't send your guess. Please try again.";
        feedback.classList.add("is-error");
        input.disabled = false;
        submit.disabled = false;
      }
    }
  });

  void loadSummary();
  window.setInterval(() => { void loadSummary(); }, 15000);
})();
