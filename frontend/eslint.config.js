// ESLint flat config (Package 5): the recommended sets for JS + TS,
// plus the classic React Hooks rule pair. Kept deliberately close to
// upstream recommendations — deviations are commented where they
// exist.
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "test-results", "playwright-report"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // The classic hooks pair. eslint-plugin-react-hooks v6+ also
      // ships the React Compiler ruleset (refs / globals /
      // immutability / set-state-in-effect); that ruleset is NOT
      // enabled — explicit baseline decision, not an oversight: it
      // targets compiler-adopting codebases and flags this app's
      // established, Vitest-pinned hook patterns (callback refs in
      // test harnesses, effect-synced zoom/feed state). Revisit if
      // the app ever adopts React Compiler.
      "react-hooks/rules-of-hooks": "error",
      // The feed's hooks compose small primitives (swipe, zoom,
      // paging) whose dependency lists are managed deliberately and
      // pinned by the Vitest suites; exhaustive-deps stays visible
      // as a warning instead of failing CI.
      "react-hooks/exhaustive-deps": "warn",
      // Leading-underscore names are the deliberate "unused on
      // purpose" convention (e.g. stub parameters in tests).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Playwright config + specs run in Node, not the browser.
    files: ["e2e/**/*.ts", "playwright.config.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
