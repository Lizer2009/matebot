import { expect, test } from "@playwright/test";

/**
 * The card a missing field produces, in a real browser at both window widths the report used.
 *
 * The invariant is not "the card looks nice" but "the reader can act on it": every declared
 * field has a control, the empty one is visible and editable, and Send is held back while it
 * stays empty. The document on screen is the production compiler's output, so this fails if the
 * compiler ever goes back to emitting a caption, and the disabled Send fails if the client stops
 * agreeing with the server's confirm gate.
 */
for (const viewport of [
  { name: "wide-1538x869", width: 1538, height: 869 },
  { name: "narrow-1100x869", width: 1100, height: 869 },
]) {
  test(`an empty body leaves the draft editable but unconfirmed at ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/e2e/fixtures/a2ui-missing-field.html?body=blank");

    await expect(page.getByTestId("fixture-missing-required")).toHaveText("body");
    const card = page.getByTestId("a2ui-surface-card");
    await expect(card).toBeVisible();

    // Every declared field has a control on screen.
    const inputs = card.locator("input, textarea");
    await expect(inputs).toHaveCount(5);

    // The action is held back while the body is empty, matching the server's confirm gate.
    await expect(card.getByTestId("a2ui-email-send")).toBeDisabled();
    // Capture the state the reader actually faces: fields on screen, body empty, Send held back.
    await page.screenshot({
      path: `test-results/p0-missing-body-${viewport.name}.png`,
      fullPage: true,
    });

    // The empty body is visible and can be typed into.
    const body = card.locator("textarea").first();
    await expect(body).toBeVisible();
    await expect(body).toHaveValue("");
    await body.fill("愿这个冬天顺遂。");
    await expect(body).toHaveValue("愿这个冬天顺遂。");

    // The values the draft already had are on the card, not lost.
    const values = await inputs.evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLInputElement | HTMLTextAreaElement).value),
    );
    expect(values).toContain("alex@example.test");
    expect(values).toContain("冬天的问候");

    // Typing the missing value makes the draft confirmable again.
    await expect(card.getByTestId("a2ui-email-send")).toBeEnabled();
    await page.screenshot({
      path: `test-results/p0-filled-body-${viewport.name}.png`,
      fullPage: true,
    });
  });
}

test("a complete draft offers Send", async ({ page }) => {
  await page.setViewportSize({ width: 1538, height: 869 });
  await page.goto("/e2e/fixtures/a2ui-missing-field.html?body=filled");
  await expect(page.getByTestId("fixture-missing-required")).toHaveText("none");
  const card = page.getByTestId("a2ui-surface-card");
  await expect(card.locator("input, textarea")).toHaveCount(5);
  await expect(card.getByTestId("a2ui-email-send")).toBeEnabled();
  await page.screenshot({ path: "test-results/p0-complete-draft.png", fullPage: true });
});
