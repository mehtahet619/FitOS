import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import security from "eslint-plugin-security";
import sonarjs from "eslint-plugin-sonarjs";

export default [
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  { linterOptions: { reportUnusedDisableDirectives: "off" } },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: "./tsconfig.json", sourceType: "module" },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      security,
      sonarjs,
    },
    rules: {
      ...security.configs.recommended.rules,
      "sonarjs/cognitive-complexity": "off",
      "sonarjs/no-duplicate-string": "off",
      "sonarjs/no-inverted-boolean-check": "error",
      "sonarjs/no-hardcoded-passwords": "off",
      "sonarjs/pseudo-random": "off",
      "sonarjs/no-floating-point-equality": "off",
      "sonarjs/no-nested-conditional": "off",
      "sonarjs/no-dead-store": "off",
      "sonarjs/no-redundant-assignments": "off",
      "sonarjs/reduce-initial-value": "off",
      "sonarjs/no-try-promise": "off",
      "sonarjs/x-powered-by": "off",
      "security/detect-object-injection": "off",
      "security/detect-unsafe-regex": "error",
      "security/detect-non-literal-fs-filename": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
];