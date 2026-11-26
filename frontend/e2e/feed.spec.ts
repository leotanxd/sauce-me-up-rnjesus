// E2E smoke specs against the stub-upstream app (see
// playwright.config.ts / stub-server.py). The stub serves 500
// galleries of 6 pages each; every gallery's page 3 is a tall
// "strip" page. Assertions lean on the app's accessible surface
// (aria labels, the visible Page X of Y line) rather than classes
// wherever possible.
import { expect, test, type Locator, type Page } from "@playwright/test";

/** The card the feed currently treats as active (the only mounted
 * article without aria-hidden — Package 1's a11y behaviour). */
function currentCard(page: Page): Locator {
  return page.locator("article:not([aria-hidden])").first();
}

async function cardNumber(card: Locator): Promise<string> {
  const text = await card.getByText(/#\d+/).first().textContent();
  return (text ?? "").trim();
}

/** The VISIBLE "Page N of 6" line. (The same text also lives in an
 * sr-only role=status region — by design — so a bare getByText
 * matches both and trips strict mode.) */
function pageLine(card: Locator, n: number): Locator {
  return card.locator("p", { hasText: `Page ${n} of 6` });
}

/** Click a card-rail button (Previous/Next page). force:true is
 * deliberate: the buttons sit at the bottom edge of a 100dvh
 * scroll-SNAP card, and Playwright's scroll-into-view can fight
 * the snap (scroll → snap back → scroll…) until the click times
 * out. A force click dispatches real pointer events at the
 * button's on-screen position without scrolling. */
async function clickRail(button: Locator): Promise<void> {
  await button.click({ force: true });
}

async function gotoFeed(page: Page): Promise<Locator> {
  await page.goto("/");
  const card = currentCard(page);
  await expect(
    card.getByRole("button", { name: "Reveal image" }),
  ).toBeVisible();
  return card;
}

test("feed loads with cards and the full right column", async ({ page }) => {
  const card = await gotoFeed(page);
  await expect(pageLine(card, 1)).toBeVisible();
  await expect(card.getByRole("button", { name: "Dim: OFF" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Next page" })).toBeEnabled();
  await expect(
    card.getByRole("button", { name: "Previous page" }),
  ).toBeDisabled();
  expect(await cardNumber(card)).toMatch(/#\d+/);
});

test("tap toggles blur off and back on", async ({ page }) => {
  const card = await gotoFeed(page);
  await card.getByRole("button", { name: "Reveal image" }).click();
  await expect(
    card.getByRole("button", { name: "Blur image" }),
  ).toBeVisible();
  // Pause past the double-tap window (~300ms): a second tap inside
  // it is a zoom gesture by design, not a blur toggle.
  await page.waitForTimeout(400);
  await card.getByRole("button", { name: "Blur image" }).click();
  await expect(
    card.getByRole("button", { name: "Reveal image" }),
  ).toBeVisible();
});

test("next/previous buttons page within the gallery", async ({ page }) => {
  const card = await gotoFeed(page);
  await clickRail(card.getByRole("button", { name: "Next page" }));
  await expect(pageLine(card, 2)).toBeVisible();
  await clickRail(card.getByRole("button", { name: "Previous page" }));
  await expect(pageLine(card, 1)).toBeVisible();
});

test("arrow-down scrolls to a different card", async ({ page }) => {
  const card = await gotoFeed(page);
  const before = await cardNumber(card);
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(async () => cardNumber(currentCard(page)))
    .not.toBe(before);
});

test("mode switch relabels the feed and keeps cards coming", async ({
  page,
}) => {
  await gotoFeed(page);
  await page.getByRole("button", { name: "Popular" }).click();
  await expect(page.getByRole("main")).toHaveAttribute(
    "aria-label",
    "Popular sauce feed",
  );
  await expect(
    currentCard(page).getByRole("button", { name: "Reveal image" }),
  ).toBeVisible();
});

test("page 3 renders as a vertically scrollable strip", async ({ page }) => {
  const card = await gotoFeed(page);
  await clickRail(card.getByRole("button", { name: "Next page" }));
  await expect(pageLine(card, 2)).toBeVisible();
  await clickRail(card.getByRole("button", { name: "Next page" }));
  await expect(pageLine(card, 3)).toBeVisible();
  const strip = card.locator(".strip-scroll");
  await expect(strip).toBeVisible();
  const metrics = await strip.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  const scrolled = await strip.evaluate((el) => {
    el.scrollTop = 400;
    return el.scrollTop;
  });
  expect(scrolled).toBeGreaterThan(0);
});

// Pointer-gesture specs: desktop Chromium only. The mobile project
// covers tap/scroll/strip; emulated-touch pinch/swipe gestures are
// the class of interaction Leo verifies on his real phone.
test.describe("pointer gestures (desktop)", () => {
  test.skip(
    ({ isMobile }) => !!isMobile,
    "mouse-driven gestures are desktop-only in this suite",
  );

  test("swipe left on the image pages forward", async ({ page }) => {
    const card = await gotoFeed(page);
    const layer = card.getByRole("button", { name: "Reveal image" });
    const box = await layer.boundingBox();
    if (!box) throw new Error("tap layer has no bounding box");
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.7, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.3, y, { steps: 12 });
    await page.mouse.up();
    await expect(pageLine(card, 2)).toBeVisible();
  });

  test("double-tap zooms the image to 2.5x", async ({ page }) => {
    const card = await gotoFeed(page);
    const layer = card.getByRole("button", { name: "Reveal image" });
    await layer.dblclick();
    const zoomLayer = card.locator(".sauce-zoom-layer");
    await expect
      .poll(async () => (await zoomLayer.getAttribute("style")) ?? "")
      .toContain("scale(2.5)");
  });
});
