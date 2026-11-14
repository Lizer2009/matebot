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
  await expect(page.getByTestId("a2ui-email-compose")).toHaveCount(0);
  await expect(page.getByTestId("a2ui-surface-folded")).toContainText("Done");
  await expect(page.getByTestId("a2ui-email-send")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "a2ui-email-sent");
});

test("email review card discard hides the draft without sending", async ({ page }) => {
  await page.goto("/e2e/fixtures/a2ui-email.html");
  await page.getByTestId("a2ui-email-discard").click();
  await expect(page.getByTestId("a2ui-email-compose")).toHaveAttribute("data-discarded", "true");
  await expect(page.getByTestId("a2ui-email-sent")).toHaveCount(0);
});

/**
 * A server that does not serve cards says so, once, instead of leaving a gap.
 *
 * Counting zero cards alone also passes when nothing rendered at all — the blank
 * region this suite exists to prevent — so the notice itself is asserted.
 */
test("email surface stays hidden when the flag is off", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/a2ui-email.html?flag=off");
  await expect(page.getByTestId("a2ui-surface-card")).toHaveCount(0);
  await expect(page.getByTestId("a2ui-email-compose")).toHaveCount(0);
  await expect(page.getByTestId("a2ui-email-send")).toHaveCount(0);
  const notice = page.getByTestId("a2ui-surface-disabled");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(/interactive cards are off/i);
  await captureScreenshot(page, testInfo, "a2ui-email-flag-off");
});

test("unbound email card shows connect and no Send", async ({ page }) => {
  await page.goto("/e2e/fixtures/a2ui-email.html?capability=not_connected");
  await expect(page.getByTestId("a2ui-email-connect")).toBeVisible();
  await expect(page.getByTestId("a2ui-email-send")).toHaveCount(0);
});

test("expired email card shows reauth and no Send", async ({ page }) => {
  await page.goto("/e2e/fixtures/a2ui-email.html?capability=requires_reauth");
  await expect(page.getByTestId("a2ui-email-reauth")).toBeVisible();
  await expect(page.getByTestId("a2ui-email-send")).toHaveCount(0);
});

test("executing email card shows Sending email and no Send", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/a2ui-email.html?lifecycle=executing");
  await expect(page.getByTestId("a2ui-email-progress")).toContainText("Sending email");
  await expect(page.getByTestId("a2ui-email-send")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "a2ui-email-progress");
});

test("succeeded email card shows Sent without the provider message id", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/fixtures/a2ui-email.html?lifecycle=succeeded");
  await expect(page.getByTestId("a2ui-surface-folded")).toContainText("Done");
  await expect(page.getByTestId("a2ui-email-compose")).toHaveCount(0);
  await expect(page.getByTestId("a2ui-email-provider-id")).toHaveCount(0);
  await expect(page.getByText("msg-1")).toHaveCount(0);
  await expect(page.getByTestId("a2ui-email-send")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "a2ui-email-success");
});

test("failed email card shows Retry and no Send", async ({ page }) => {
  await page.goto("/e2e/fixtures/a2ui-email.html?lifecycle=failed");
  await expect(page.getByTestId("a2ui-surface-folded")).toContainText("Failed");
  await expect(page.getByTestId("a2ui-surface-retry")).toBeVisible();
  await expect(page.getByTestId("a2ui-email-send")).toHaveCount(0);
});

test("failed send from the card never shows Sent", async ({ page }) => {
  await page.goto("/e2e/fixtures/a2ui-email.html?send=fail");
  await page.getByTestId("a2ui-email-send").click();
  await expect(page.getByTestId("a2ui-surface-folded")).toContainText("Failed");
  await expect(page.getByTestId("a2ui-email-sent")).toHaveCount(0);
  await expect(page.getByTestId("a2ui-email-compose")).toHaveCount(0);
});

test("unknown email card shows Check status and no Send", async ({ page }) => {
  await page.goto("/e2e/fixtures/a2ui-email.html?lifecycle=unknown");
  await expect(page.getByTestId("a2ui-email-unknown")).toContainText("Don't send again");
  await expect(page.getByTestId("a2ui-email-check-status")).toBeVisible();
  await expect(page.getByTestId("a2ui-email-send")).toHaveCount(0);
  await expect(page.getByTestId("a2ui-email-retry")).toHaveCount(0);
});

test("superseded card folds with no Send and no Retry", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/a2ui-email.html?status=superseded");
  await expect(page.getByTestId("a2ui-surface-superseded")).toContainText(
    "Replaced by a newer draft",
  );
  await expect(page.getByTestId("a2ui-email-send")).toHaveCount(0);
  await expect(page.getByTestId("a2ui-surface-retry")).toHaveCount(0);
  await expect(page.getByTestId("a2ui-email-compose")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "a2ui-email-superseded");
});

test("expired card offers only Retry", async ({ page }, testInfo) => {
  await page.goto("/e2e/fixtures/a2ui-email.html?status=expired");
  await expect(page.getByTestId("a2ui-surface-folded")).toContainText("Expired, nothing was sent");
  await expect(page.getByTestId("a2ui-surface-retry")).toBeVisible();
  await expect(page.getByTestId("a2ui-email-send")).toHaveCount(0);
  await expect(page.getByTestId("a2ui-email-compose")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "a2ui-email-expired");
});

test("cancelled card folds as Discarded with no Retry", async ({ page }) => {
  await page.goto("/e2e/fixtures/a2ui-email.html?status=cancelled");
  await expect(page.getByTestId("a2ui-surface-folded")).toContainText("Discarded");
  await expect(page.getByTestId("a2ui-surface-retry")).toHaveCount(0);
  await expect(page.getByTestId("a2ui-email-send")).toHaveCount(0);
});

test("folded card stays one line on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/e2e/fixtures/a2ui-email.html?status=superseded");
  const card = page.getByTestId("a2ui-surface-card");
  await expect(card).toBeVisible();
  const box = await card.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.width).toBeLessThanOrEqual(390);
  await expect(page.getByTestId("a2ui-email-send")).toHaveCount(0);
});
