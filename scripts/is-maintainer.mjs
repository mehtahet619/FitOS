import fs from "node:fs";

const policy = fs.readFileSync(".github/review-policy.yml", "utf8");
const section = policy.slice(policy.indexOf("maintainers:"));
const maintainers = [...section.matchAll(/^\s+-\s+"([^"]+)"/gm)].map((match) => match[1]);

process.exit(maintainers.includes(process.argv[2] || "") ? 0 : 1);