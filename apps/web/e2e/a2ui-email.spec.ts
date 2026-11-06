import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("email review card edits then sends in one gesture", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/a2ui-email.html");
  await expect(page.getByTestId("a2ui-email-to")).toHaveValue("a@example.com");
  await expect(page.getByTestId("a2ui-email-status")).toContainText("Needs approval");
  await expect(page.getByTestId("a2ui-email-confirm")).toHaveCount(0);
  await page.getByTestId("a2ui-email-subject").fill("Hello again");
  await page.getByTestId("a2ui-email-subject").blur();
  await page.getByTestId("a2ui-email-send").click();
  await expect(page.getByTestId("a2ui-email-sent")).toBeVisible();
  await expect(page.getByTestId("a2ui-email-compose")).toHaveAttribute("data-sent", "true");
  await captureScreenshot(page, testInfo, "a2ui-email-sent");
});

test("email review card discard hides the draft without sending", async ({ page }) => {
  await page.goto("/e2e/fixtures/a2ui-email.html");
  await page.getByTestId("a2ui-email-discard").click();
  await expect(page.getByTestId("a2ui-email-compose")).toHaveAttribute("data-discarded", "true");
  await expect(page.getByTestId("a2ui-email-sent")).toHaveCount(0);
});

test("email surface stays hidden when the flag is off", async ({ page }) => {
  await page.goto("/e2e/fixtures/a2ui-email.html?flag=off");
  await expect(page.getByTestId("a2ui-surface-card")).toHaveCount(0);
  await expect(page.getByTestId("a2ui-email-compose")).toHaveCount(0);
});

test("unbound email card shows connect and no Send", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/a2ui-email.html?capability=not_connected");
  await expect(page.getByTestId("a2ui-email-connect")).toBeVisible();
  await expect(page.getByTestId("a2ui-email-send")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "a2ui-email-connect");
});

test("expired email card shows reauth and no Send", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/a2ui-email.html?capability=requires_reauth");
  await expect(page.getByTestId("a2ui-email-reauth")).toBeVisible();
  await expect(page.getByTestId("a2ui-email-send")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "a2ui-email-reauth");
});
