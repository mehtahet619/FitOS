// Render injects API_BASE_URL at build time. Keep local development simple,
// and allow static hosting environments to provide the API URL explicitly.
const configuredApiBase = "__API_BASE_URL__";
const configuredPublicSiteUrl = "__PUBLIC_SITE_URL__";
window.PUBLIC_SITE_URL = /^https:\/\//i.test(configuredPublicSiteUrl)
  ? configuredPublicSiteUrl.replace(/\/$/, "")
  : window.location.origin;
window.API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "http://localhost:4000"
  : configuredApiBase.startsWith("https://")
    ? configuredApiBase.replace(/\/$/, "")
    : "https://adaptive-fit-api.onrender.com";

// Public measurement IDs are injected at build time. No provider is loaded
// until the visitor explicitly accepts optional analytics cookies.
window.FITOS_GA4_ID = "__GA4_MEASUREMENT_ID__";
window.FITOS_CLARITY_ID = "__CLARITY_PROJECT_ID__";
