const fs = require("node:fs");
const path = require("node:path");

const apiBaseUrl = process.env.API_BASE_URL;
if (!apiBaseUrl || !/^https:\/\//i.test(apiBaseUrl)) {
  throw new Error("Set API_BASE_URL to the HTTPS URL of the FitOS API service.");
}

const configPath = path.join(__dirname, "..", "frontend", "config.js");
const source = fs.readFileSync(configPath, "utf8");
fs.writeFileSync(configPath, source.replace("__API_BASE_URL__", apiBaseUrl.replace(/\/$/, "")), "utf8");
console.log(`Configured frontend API endpoint: ${new URL(apiBaseUrl).origin}`);
