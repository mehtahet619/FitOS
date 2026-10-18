(() => {
  "use strict";

  const GA_ID = typeof window.FITOS_GA4_ID === "string" ? window.FITOS_GA4_ID : "";
  const CLARITY_ID = typeof window.FITOS_CLARITY_ID === "string" ? window.FITOS_CLARITY_ID : "";
  const CONSENT_KEY = "fitos-optional-analytics-consent";
  const hasProvider = Boolean(GA_ID || CLARITY_ID);
  let initialized = false;

  function consentValue() {
    try { return localStorage.getItem(CONSENT_KEY); } catch { return null; }
  }

  function isPublicPage() {
    return ["/", "/terms", "/terms.html", "/privacy", "/privacy.html"].includes(window.location.pathname);
  }

  function loadGa4() {
    if (!GA_ID || window.__fitosGa4Loaded) return;
    window.__fitosGa4Loaded = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function gtag() { window.dataLayer.push(arguments); };
    window.gtag("consent", "default", {
      analytics_storage: "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied"
    });
    window.gtag("js", new Date());
    window.gtag("consent", "update", {
      analytics_storage: "granted",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied"
    });
    window.gtag("config", GA_ID, { send_page_view: false, allow_google_signals: false });
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(GA_ID);
    script.referrerPolicy = "strict-origin-when-cross-origin";
    document.head.appendChild(script);
    if (isPublicPage()) window.gtag("event", "page_view", { page_path: window.location.pathname });
  }

  function loadClarity() {
    if (!CLARITY_ID || window.__fitosClarityLoaded) return;
    window.__fitosClarityLoaded = true;
    (function(c,l,a,r,i,t,y){
      c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments);};
      t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
      t.referrerPolicy="strict-origin-when-cross-origin";
      y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
    })(window, document, "clarity", "script", CLARITY_ID);
    window.clarity("consentv2", {
      ad_Storage: "denied",
      analytics_Storage: "granted"
    });
  }

  function maskPrivateScreensForClarity() {
    document.querySelectorAll('.screen:not(#screen-landing)').forEach((element) => {
      element.setAttribute('data-clarity-mask', 'true');
    });
  }

  function applyConsentSignals(value) {
    const granted = value === "accepted";
    if (typeof window.gtag === "function" && GA_ID) {
      window.gtag("consent", "update", {
        analytics_storage: granted ? "granted" : "denied",
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied"
      });
    }
    if (typeof window.clarity === "function" && CLARITY_ID) {
      window.clarity("consentv2", {
        ad_Storage: "denied",
        analytics_Storage: granted ? "granted" : "denied"
      });
    }
  }

  function initializeProviders() {
    if (initialized || consentValue() !== "accepted") return;
    initialized = true;
    loadGa4();
    maskPrivateScreensForClarity();
    loadClarity();
    applyConsentSignals("accepted");
  }

  function setConsent(value) {
    try { localStorage.setItem(CONSENT_KEY, value); } catch {}
    const banner = document.getElementById("fitos-consent-banner");
    if (banner) banner.hidden = true;
    if (value === "accepted") initializeProviders();
    applyConsentSignals(value);
  }

  function mountConsentUi() {
    if (!hasProvider || document.getElementById("fitos-consent-banner")) return;
    const banner = document.createElement("section");
    banner.id = "fitos-consent-banner";
    banner.className = "fitos-consent-banner";
    banner.setAttribute("aria-label", "Optional analytics preferences");
    banner.setAttribute("aria-live", "polite");
    banner.hidden = consentValue() !== null;
    banner.innerHTML = `
      <div class="fitos-consent-copy">
        <strong>Help us improve FitOS</strong>
        <p>Optional analytics help us understand site usage and usability. They stay off unless you accept. You can change this choice later in Cookie settings.</p>
        <a href="/privacy">Read our Privacy Policy</a>
      </div>
      <div class="fitos-consent-actions">
        <button type="button" class="fitos-consent-reject">Reject optional</button>
        <button type="button" class="fitos-consent-accept">Accept analytics</button>
      </div>`;
    banner.querySelector(".fitos-consent-reject").addEventListener("click", () => setConsent("rejected"));
    banner.querySelector(".fitos-consent-accept").addEventListener("click", () => setConsent("accepted"));
    document.body.appendChild(banner);

    const settings = document.createElement("button");
    settings.type = "button";
    settings.className = "fitos-cookie-settings";
    settings.textContent = "Cookie settings";
    settings.setAttribute("aria-label", "Change optional analytics preferences");
    settings.addEventListener("click", () => {
      banner.hidden = false;
      const accept = banner.querySelector(".fitos-consent-accept");
      if (accept) accept.focus();
    });
    document.body.appendChild(settings);
  }

  function track(eventName) {
    if (consentValue() !== "accepted") return;
    const allowedEvents = new Set([
      "sign_up",
      "login",
      "workout_plan_created",
      "workout_generated",
      "equipment_analysis_completed"
    ]);
    if (!allowedEvents.has(eventName)) return;
    if (typeof window.gtag === "function" && GA_ID) window.gtag("event", eventName);
    if (typeof window.clarity === "function" && CLARITY_ID) window.clarity("event", eventName);
  }

  window.FitOSAnalytics = { track };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      mountConsentUi();
      initializeProviders();
    }, { once: true });
  } else {
    mountConsentUi();
    initializeProviders();
  }
})();
