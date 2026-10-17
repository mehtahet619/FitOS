(() => {
  const form = document.getElementById("price-guess-form");
  if (!form || typeof Api === "undefined") return;

  const input = document.getElementById("price-guess-input");
  const submit = document.getElementById("price-guess-submit");
  const feedback = document.getElementById("price-guess-feedback");
  const average = document.getElementById("price-guess-average");
  const count = document.getElementById("price-guess-count");
  const numberFormat = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
  let summary = { authenticated: false, hasGuessed: false };

  function renderSummary(data) {
    summary = {
      authenticated: Boolean(data?.authenticated),
      hasGuessed: Boolean(data?.hasGuessed),
      userGuess: Number.isSafeInteger(data?.userGuess) ? data.userGuess : null,
    };
    average.textContent = Number.isFinite(data?.average)
      ? `₹${numberFormat.format(data.average)} / month`
      : "No guesses yet";
    const total = Number.isSafeInteger(data?.count) ? data.count : 0;
    count.textContent = `${total.toLocaleString("en-IN")} ${total === 1 ? "guess" : "guesses"} so far`;

    const locked = !summary.authenticated || summary.hasGuessed;
    input.disabled = locked;
    submit.disabled = locked;
    if (summary.hasGuessed) {
      feedback.textContent = `You've already guessed ₹${numberFormat.format(summary.userGuess)}. Each account gets one guess.`;
      feedback.classList.remove("is-error");
    } else if (!summary.authenticated) {
      feedback.textContent = "Log in to submit your one price guess. The community average is shared with everyone.";
      feedback.classList.remove("is-error");
    } else if (!feedback.classList.contains("is-error")) {
      feedback.textContent = "You get one guess per account. Your guess updates the shared community average.";
    }
  }

  async function loadSummary() {
    try {
      renderSummary(await Api.get("/pricing-guesses"));
    } catch {
      average.textContent = "Temporarily unavailable";
      count.textContent = "Community average could not be loaded. Please try again later.";
      input.disabled = true;
      submit.disabled = true;
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!summary.authenticated) {
      feedback.textContent = "Please log in before submitting your one guess.";
      feedback.classList.add("is-error");
      return;
    }
    if (summary.hasGuessed) {
      feedback.textContent = "You've already submitted your one guess.";
      feedback.classList.add("is-error");
      return;
    }

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
      const result = await Api.post("/pricing-guesses", { price });
      renderSummary({ ...result, authenticated: true });
      feedback.textContent = `Your one guess of ₹${numberFormat.format(price)} is saved. The community average is now shared with everyone.`;
    } catch (error) {
      await loadSummary();
      if (summary.hasGuessed) {
        feedback.textContent = `You've already submitted your guess of ₹${numberFormat.format(summary.userGuess)}. The shared total has been refreshed.`;
      } else {
        feedback.textContent = error?.message || "Couldn't send your guess. Please try again.";
        feedback.classList.add("is-error");
        input.disabled = false;
        submit.disabled = false;
      }
    }
  });

  void loadSummary();
  // This now refreshes from the shared database, not process-local memory.
  window.setInterval(() => { void loadSummary(); }, 15000);
})();
