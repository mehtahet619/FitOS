import fs from "node:fs";

const policy = fs.readFileSync(".github/review-policy.yml", "utf8");
const section = policy.slice(0, policy.indexOf("maintainers:"));
const patterns = [...section.matchAll(/^\s+-\s+"([^"]+)"/gm)].map((match) => match[1]);

const globToRegExp = (pattern) => {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const doubleStar = "__DOUBLE_STAR__";
  const regexSource = escaped
    .replaceAll("**", doubleStar)
    .replaceAll("*", "[^/]*")
    .replaceAll(doubleStar, ".*");
  return new RegExp(`^${regexSource}$`);
};

const file = process.argv[2] || "";
process.exit(patterns.some((pattern) => globToRegExp(pattern).test(file)) ? 0 : 1);