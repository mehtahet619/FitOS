(() => {
  const form = document.getElementById("price-guess-form");
  if (!form || typeof Api === "undefined") return;

  const input = document.getElementById("price-guess-input");
  const submit = document.getElementById("price-guess-submit");
  const feedback = document.getElementById("price-guess-feedback");
  const average = document.getElementById("price-guess-average");
  const count = document.getElementById("price-guess-count");
  const numberFormat = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });

  function renderSummary(data) {
    average.textContent = Number.isFinite(data?.average)
      ? `₹${numberFormat.format(data.average)} / month`
      : "Be the first to guess";
    const total = Number.isSafeInteger(data?.count) ? data.count : 0;
    count.textContent = `${total.toLocaleString("en-IN")} ${total === 1 ? "guess" : "guesses"} so far`;
  }

  async function loadSummary() {
    try {
      renderSummary(await Api.get("/pricing-guesses"));
    } catch (error) {
      average.textContent = "Temporarily unavailable";
      count.textContent = "Community average could not be loaded. Please try again later.";
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const price = Number(input.value);
    if (!Number.isSafeInteger(price) || price < 1 || price > 100000) {
      feedback.textContent = "Enter a whole amount between ₹1 and ₹1,00,000.";
      feedback.classList.add("is-error");
      input.focus();
      return;
    }

    submit.disabled = true;
    feedback.classList.remove("is-error");
    feedback.textContent = "Sending your guess…";
    try {
      const result = await Api.post("/pricing-guesses", { price });
      renderSummary(result);
      feedback.textContent = "Your guess is in. Thanks for helping shape FitOS!";
      input.value = "";
    } catch (error) {
      feedback.textContent = error?.message || "Couldn't send your guess. Please try again.";
      feedback.classList.add("is-error");
    } finally {
      submit.disabled = false;
    }
  });

  void loadSummary();
  // Refresh the in-memory community total so visitors on the page see new guesses.
  window.setInterval(() => { void loadSummary(); }, 15000);
})();
