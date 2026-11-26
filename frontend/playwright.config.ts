// Playwright E2E smoke suite (Package 5): the real built app
// (frontend/dist, served by the real FastAPI backend) against a
// generative stub upstream — see e2e/stub-server.py. Hermetic: no
// live network, no real upstream quota spent.
//
// Prerequisites: the frontend must be built (`npm run build`) and a
// Python with the dev environment importable must be named by
// E2E_PYTHON (default "python3"; CI sets it after installing
// requirements-dev.txt).
import { defineConfig, devices } from "@playwright/test";

const python = process.env.E2E_PYTHON ?? "python3";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "*.spec.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // The two stub instances are shared per-port state; keep specs
  // serial so the fail-search toggle can't race another test.
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8901",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"] },
    },
  ],
  // One shared instance for the feed specs. (The error/retry spec
  // spawns its own throwaway instance — see feed-error.spec.ts.)
  webServer: {
    command: `${python} e2e/stub-server.py`,
    url: "http://127.0.0.1:8901/api/health",
    env: { E2E_APP_PORT: "8901", E2E_IMG_PORT: "8902" },
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
