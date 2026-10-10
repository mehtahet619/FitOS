(() => {
  const screen = document.getElementById("screen-intro");
  const background = screen?.querySelector(".intro-image-fallback img");
  let finishPromise;

  // Keep the normal branded boot screen. Reward and tree imagery belongs only
  // in the authenticated dashboard, never in this loading experience.
  window.FitOSIntroReady = Promise.resolve(background?.complete ?? true);
  window.FitOSIntroStart = () => {
    screen?.classList.remove("intro-screen--leaving");
    finishPromise = null;
  };
  window.FitOSIntroFinishWhenReady = () => {
    if (finishPromise) return finishPromise;
    finishPromise = new Promise((resolve) => {
      screen?.classList.add("intro-screen--leaving");
      setTimeout(resolve, 420);
    });
    return finishPromise;
  };
})();
