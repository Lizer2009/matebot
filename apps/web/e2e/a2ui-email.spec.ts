import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("email compose edits, confirms, then sends", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/a2ui-email.html");
  await expect(page.getByTestId("a2ui-email-to")).toHaveValue("a@example.com");
  await page.getByTestId("a2ui-email-subject").fill("Hello again");
  await page.getByTestId("a2ui-email-send").click();
  await expect(page.getByTestId("a2ui-email-error")).toContainText("Confirm this draft");
  await page.getByTestId("a2ui-email-confirm").click();
  await expect(page.getByTestId("a2ui-email-compose")).toHaveAttribute("data-confirmed", "true");
  await expect(page.getByTestId("a2ui-email-subject")).toHaveValue("Hello again");
  await page.getByTestId("a2ui-email-send").click();
  await expect(page.getByTestId("a2ui-email-sent")).toBeVisible();
  await captureScreenshot(page, testInfo, "a2ui-email-sent");
});

test("email surface stays hidden when the flag is off", async ({ page }) => {
  await page.goto("/e2e/fixtures/a2ui-email.html?flag=off");
  await expect(page.getByTestId("a2ui-surface-card")).toHaveCount(0);
  await expect(page.getByTestId("a2ui-email-compose")).toHaveCount(0);
});
