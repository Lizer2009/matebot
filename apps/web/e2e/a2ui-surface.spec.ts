import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("A2UI surface fixture renders a timeline card when the flag is on", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/fixtures/a2ui-surface.html");
  await expect(page.getByTestId("a2ui-surface-card")).toBeVisible();
  await expect(page.getByText("A2UI fixture", { exact: true })).toBeVisible();
  await expect(page.getByTestId("a2ui-surface-host")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Hello from Matebot A2UI fixture")).toBeVisible();
  await captureScreenshot(page, testInfo, "a2ui-surface-fixture");
});

test("A2UI surface fixture refuses unknown catalog components", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/a2ui-surface.html?refuse=1");
  await expect(page.getByTestId("a2ui-surface-refused")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("This card could not be shown.")).toBeVisible();
  await expect(page.getByText(/EvilWidget/)).toHaveCount(0);
  await captureScreenshot(page, testInfo, "a2ui-e2e-t321-safe-degrade");
});

/**
 * A server that does not serve cards produces a sentence, not a blank region.
 *
 * Before this, the block returned null and the reader saw an unexplained gap while the
 * conversation told them to use a card that was never on screen.
 */
test("a card the server does not serve says so instead of vanishing", async ({ page }) => {
  await page.goto("/e2e/fixtures/a2ui-surface.html?flag=off");
  await expect(page.getByTestId("a2ui-surface-card")).toHaveCount(0);
  const notice = page.getByTestId("a2ui-surface-disabled");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(/interactive cards are off/i);
});
