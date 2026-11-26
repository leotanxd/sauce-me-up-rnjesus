// Error/retry smoke spec. This spec spawns its OWN stub instance
// (fresh process on dedicated ports, booted with the upstream
// search endpoint down) instead of sharing the config's servers:
// the app's pools / detail cache / no-repeat window live for the
// life of a process, so a shared "bad" instance that an earlier
// test already healed can never fail again — each run of this spec
// gets a cold, genuinely-down instance.
import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = "http://127.0.0.1:8905";
const CONTROL = "http://127.0.0.1:8906";

let server: ChildProcess | undefined;

async function waitForHealth(url: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`no health from ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

test.beforeAll(async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  server = spawn(process.env.E2E_PYTHON ?? "python3", [
    path.join(here, "stub-server.py"),
  ], {
    env: {
      ...process.env,
      E2E_APP_PORT: "8905",
      E2E_IMG_PORT: "8906",
      E2E_FAIL_SEARCH: "1",
    },
    stdio: "ignore",
  });
  await waitForHealth(APP);
});

test.afterAll(() => {
  server?.kill();
});

test("upstream outage shows an error state and retry recovers", async ({
  page,
  request,
}) => {
  await page.goto(`${APP}/`);
  const retry = page.getByRole("button", { name: "Tap to retry" });
  await expect(retry).toBeVisible({ timeout: 30_000 });

  await request.get(`${CONTROL}/__control/fail-search/off`);
  await retry.click();

  const card = page.locator("article:not([aria-hidden])").first();
  await expect(
    card.getByRole("button", { name: "Reveal image" }),
  ).toBeVisible();
  // The visible page line (the same text also lives in an sr-only
  // status region, so scope to the paragraph).
  await expect(card.locator("p", { hasText: "Page 1 of 6" })).toBeVisible();
});
