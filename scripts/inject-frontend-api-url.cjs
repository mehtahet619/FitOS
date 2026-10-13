const fs = require("node:fs");
const path = require("node:path");

const apiBaseUrl = process.env.API_BASE_URL;
if (!apiBaseUrl || !/^https:\/\//i.test(apiBaseUrl)) {
  throw new Error("Set API_BASE_URL to the HTTPS URL of the FitOS API service.");
}
const publicSiteUrl = process.env.PUBLIC_SITE_URL;
if (!publicSiteUrl) {
  throw new Error("Set PUBLIC_SITE_URL to the canonical HTTPS origin of the FitOS website.");
}
let publicSiteOrigin;
try {
  const parsedPublicSiteUrl = new URL(publicSiteUrl);
  if (parsedPublicSiteUrl.protocol !== "https:" || parsedPublicSiteUrl.username || parsedPublicSiteUrl.password || parsedPublicSiteUrl.pathname !== "/" || parsedPublicSiteUrl.search || parsedPublicSiteUrl.hash) {
    throw new Error();
  }
  publicSiteOrigin = parsedPublicSiteUrl.origin;
} catch {
  throw new Error("PUBLIC_SITE_URL must be an HTTPS origin without a path, query, or credentials.");
}

const configPath = path.join(__dirname, "..", "frontend", "config.js");
const source = fs.readFileSync(configPath, "utf8");
fs.writeFileSync(
  configPath,
  source
    .replace("__API_BASE_URL__", apiBaseUrl.replace(/\/$/, ""))
    .replace("__PUBLIC_SITE_URL__", publicSiteOrigin),
  "utf8",
);

const siteFiles = ["index.html", "app.js", "robots.txt", "sitemap.xml"];
for (const filename of siteFiles) {
  const filePath = path.join(__dirname, "..", "frontend", filename);
  const siteSource = fs.readFileSync(filePath, "utf8");
  fs.writeFileSync(filePath, siteSource.replaceAll("https://adaptive-fit-web.onrender.com", publicSiteOrigin), "utf8");
}

console.log(`Configured frontend API endpoint: ${new URL(apiBaseUrl).origin}`);
console.log(`Configured canonical website origin: ${publicSiteOrigin}`);
