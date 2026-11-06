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

test("A2UI surface fixture refuses unknown catalog components", async ({ page }) => {
  await page.goto("/e2e/fixtures/a2ui-surface.html?refuse=1");
  await expect(page.getByTestId("a2ui-surface-refused")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/EvilWidget/)).toBeVisible();
});

test("A2UI surface blocks stay hidden when the flag is off", async ({ page }) => {
  await page.goto("/e2e/fixtures/a2ui-surface.html?flag=off");
  await expect(page.getByTestId("a2ui-surface-card")).toHaveCount(0);
});
